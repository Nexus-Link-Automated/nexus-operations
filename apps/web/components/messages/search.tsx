/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { CheckboxField } from "@makeplane/propel/components/checkbox-field";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { Input, InputGroup } from "@makeplane/propel/components/input";
import { CloseOutline, HashOutline, LockOutline, SearchOutline } from "@makeplane/propel/icons";
import { Spinner } from "@plane/blocks/spinner";
import { useTranslation } from "@plane/i18n";
import type { TChatSearchResult, TChatSearchSnippetSegment } from "@plane/types";
import { renderFormattedDate, renderFormattedTime } from "@plane/utils";
// components
import { MemberSelect } from "@/components/dropdowns/member/member-select";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
// store
import { CHAT_SEARCH_MAX_LENGTH, CHAT_SEARCH_MIN_LENGTH } from "@/store/chat.store";
import type { TChatSearchFilters } from "@/store/chat.store";
// local imports
import { channelDisplayName, chatMessagePermalink, chatSender, chatSenderName, localDay } from "./helpers";
import { ChatAgentAvatar, ChatAgentTag, MemberAvatar } from "./member-avatar";

/** Typing pauses this long before a search is sent. */
export const CHAT_SEARCH_DEBOUNCE_MS = 300;

/**
 * The search box at the top of the Messages sidebar. Searching starts once there are two characters and typing pauses;
 * Enter searches at once, Escape clears it. The results show in `ChatSearchPanel`.
 */
export const ChatSearchBox = observer(function ChatSearchBox({ onSearch }: { onSearch: () => void }) {
  const { t } = useTranslation();
  const chat = useChat();
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searching = chat.search !== null;

  // The panel was closed: the box empties with it.
  useEffect(() => {
    if (!searching) setText((current) => (current.trim().length >= CHAT_SEARCH_MIN_LENGTH ? "" : current));
  }, [searching]);
  useEffect(() => () => cancel(), []);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  const run = (value: string) => {
    cancel();
    if (value.trim().length < CHAT_SEARCH_MIN_LENGTH) return chat.clearSearch();
    // The thread would sit where the results go.
    if (chat.activeThread) chat.closeThread();
    onSearch();
    void chat.searchMessages(value, chat.search?.filters);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      run(text);
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      cancel();
      setText("");
      chat.clearSearch();
    }
  };

  return (
    <div className="px-3 pb-3">
      <InputGroup size="md">
        <SearchOutline className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
        <Input
          size="md"
          type="search"
          name="chat-search"
          autoComplete="off"
          maxLength={CHAT_SEARCH_MAX_LENGTH}
          placeholder={t("messages.search.placeholder")}
          aria-label={t("messages.search.placeholder")}
          value={text}
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            cancel();
            timer.current = setTimeout(() => run(value), CHAT_SEARCH_DEBOUNCE_MS);
          }}
          onFocus={() => {
            if (searching) onSearch();
          }}
          onKeyDown={handleKeyDown}
        />
      </InputGroup>
    </div>
  );
});

type PanelProps = {
  workspaceSlug: string;
  /** The conversation open beside the panel, which the "only here" filter narrows to. */
  channelId: string | undefined;
  /** A result was opened. */
  onOpenResult: () => void;
};

/**
 * The latest search's results, newest first, with its filters. Each result opens its message, or a reply in its
 * thread, highlighted. Escape or the close button ends the search. Below `lg` it takes the conversation's place.
 */
export const ChatSearchPanel = observer(function ChatSearchPanel({
  workspaceSlug,
  channelId,
  onOpenResult,
}: PanelProps) {
  const { t } = useTranslation();
  const chat = useChat();
  const { getUserDetails } = useMember();
  const headingId = useId();
  const search = chat.search;
  if (!search) return null;

  const filters = search.filters;
  const refine = (change: Partial<TChatSearchFilters>) =>
    void chat.searchMessages(search.query, { ...filters, ...change });
  // The channel the filter narrows to: the one it was set on, else the one open now.
  const scopeId = filters.channelId ?? channelId;
  const scopeChannel = scopeId
    ? (chat.channelMap[scopeId] ?? search.results.find((result) => result.channel.id === scopeId)?.channel)
    : undefined;
  const scopeName = scopeChannel
    ? channelDisplayName(
        scopeChannel,
        chat.userId,
        (id) => getUserDetails(id)?.display_name,
        t("messages.unknown_member")
      )
    : "";

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    chat.clearSearch();
  };

  return (
    <aside
      aria-labelledby={headingId}
      className="flex min-h-0 w-full min-w-0 flex-col border-subtle bg-surface-1 lg:w-96 lg:flex-shrink-0 lg:border-l"
      onKeyDown={handleKeyDown}
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-4 py-2.5">
        <h2 id={headingId} className="min-w-0 flex-1 truncate text-body-md-semibold text-primary">
          {t("messages.search.title")}
        </h2>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<CloseOutline />}
          aria-label={t("messages.search.close")}
          onClick={() => chat.clearSearch()}
        />
      </header>
      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-subtle px-4 py-2">
        {scopeChannel && (
          <CheckboxField
            size="md"
            label={t("messages.search.only_in", { name: scopeName })}
            checked={!!filters.channelId}
            onCheckedChange={(checked) => refine({ channelId: checked ? scopeChannel.id : undefined })}
          />
        )}
        <div className="flex items-center gap-2">
          <span className="text-caption-md-regular text-tertiary">{t("messages.search.from")}</span>
          <MemberSelect
            variant="pill-sm"
            value={filters.senderId ?? null}
            onChange={(id) => refine({ senderId: id || undefined })}
            clearable
            clearLabel={t("messages.search.anyone")}
            placeholder={t("messages.search.anyone")}
          />
        </div>
        <CheckboxField
          size="md"
          label={t("messages.search.include_automatic")}
          checked={!filters.excludeAutomatic && !filters.senderId}
          disabled={!!filters.senderId}
          onCheckedChange={(checked) => refine({ excludeAutomatic: !checked })}
        />
      </div>

      {search.loading ? (
        <div
          className="flex flex-1 items-center justify-center"
          role="status"
          aria-label={t("messages.search.loading")}
        >
          <Spinner />
        </div>
      ) : search.error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p role="alert" className="text-body-sm-regular text-secondary">
            {t(search.rateLimited ? "messages.search.rate_limited" : "messages.search.failed")}
          </p>
          <Button
            variant="secondary"
            size="sm"
            stretch="auto"
            label={t("messages.errors.retry")}
            onClick={() => void chat.searchMessages(search.query, filters)}
          />
        </div>
      ) : search.results.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
          <p className="text-body-sm-medium text-primary">{t("messages.search.empty_title")}</p>
          <p className="text-body-sm-regular text-tertiary">{t("messages.search.empty", { query: search.query })}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          <ul aria-label={t("messages.search.title")} className="flex flex-col">
            {search.results.map((result) => (
              <li key={result.message.id}>
                <ChatSearchResultRow workspaceSlug={workspaceSlug} result={result} onOpen={onOpenResult} />
              </li>
            ))}
          </ul>
          {search.hasMore && (
            <div className="flex flex-col items-center gap-1 px-4 pt-2">
              {search.moreFailed && (
                <p role="alert" className="text-caption-md-regular text-secondary">
                  {t(search.rateLimited ? "messages.search.rate_limited" : "messages.search.more_failed")}
                </p>
              )}
              <Button
                variant="ghost"
                size="sm"
                stretch="auto"
                loading={search.loadingMore}
                label={search.moreFailed ? t("messages.errors.retry") : t("messages.search.load_more")}
                onClick={() => void chat.loadMoreSearchResults()}
              />
            </div>
          )}
        </div>
      )}
    </aside>
  );
});

type RowProps = {
  workspaceSlug: string;
  result: TChatSearchResult;
  onOpen: () => void;
};

/** One result: where and who it's from, when, and the matching words, which open the message. */
const ChatSearchResultRow = observer(function ChatSearchResultRow({ workspaceSlug, result, onOpen }: RowProps) {
  const { t } = useTranslation();
  const chat = useChat();
  const { getUserDetails } = useMember();
  const { message, channel } = result;
  const channelName = channelDisplayName(
    channel,
    chat.userId,
    (id) => getUserDetails(id)?.display_name,
    t("messages.unknown_member")
  );
  const sender = chatSender(message);
  const senderName = chatSenderName(message, (id) => getUserDetails(id)?.display_name, t);
  const when =
    localDay(message.created_at) === localDay(new Date().toISOString())
      ? renderFormattedTime(message.created_at, "12-hour")
      : (renderFormattedDate(message.created_at) ?? "");
  const files = message.attachments.map((attachment) => attachment.name).join(", ");

  return (
    <Link
      href={chatMessagePermalink(workspaceSlug, {
        id: message.id,
        channel_id: message.channel,
        parent_id: message.parent,
      })}
      onClick={onOpen}
      className="flex gap-3 px-4 py-2 hover:bg-layer-transparent-hover focus-visible:bg-layer-transparent-hover"
    >
      <div className="flex w-8 flex-shrink-0 justify-center pt-0.5">
        {sender.kind === "agent" ? (
          <ChatAgentAvatar adapter={sender.adapter} size="md" />
        ) : (
          <MemberAvatar userId={message.sender} size="md" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1 text-caption-md-regular text-tertiary">
          {channel.kind === "private" ? (
            <LockOutline className="size-3 flex-shrink-0" aria-hidden />
          ) : channel.kind === "public" ? (
            <HashOutline className="size-3 flex-shrink-0" aria-hidden />
          ) : null}
          <span className="truncate">{channelName}</span>
          {channel.archived_at && <span className="flex-shrink-0">· {t("messages.search.archived")}</span>}
          {message.parent && <span className="flex-shrink-0">· {t("messages.search.in_thread")}</span>}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="truncate text-body-sm-semibold text-primary">{senderName}</span>
          {sender.kind === "agent" && <ChatAgentTag />}
          <time dateTime={message.created_at} className="flex-shrink-0 text-caption-sm-regular text-tertiary">
            {when}
          </time>
        </div>
        <ChatSearchSnippet segments={result.snippet} />
        {files && <p className="truncate text-caption-md-regular text-tertiary">{files}</p>}
      </div>
    </Link>
  );
});

/** The matching words in their context. Plain text from the API, rendered as text: only the marks are ours. */
export function ChatSearchSnippet({ segments }: { segments: TChatSearchSnippetSegment[] }) {
  return (
    <p className="line-clamp-3 text-body-sm-regular break-words whitespace-pre-line text-secondary">
      {segments.map((segment, index) => {
        const Segment = segment.match ? "mark" : "span";
        const className = segment.match ? "rounded-sm bg-accent-subtle px-0.5 text-primary" : undefined;
        // A snippet is replaced whole, never reordered, so its segments' places are their identity.
        const key = index;
        return (
          <Segment key={key} className={className}>
            {segment.text}
          </Segment>
        );
      })}
    </p>
  );
}
