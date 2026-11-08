/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { Spinner } from "@plane/blocks/spinner";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { renderFormattedDate } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { buildMessageRows, localDay } from "./helpers";
import { ChatMessageItem, ChatPendingMessageItem } from "./message-item";

/** Within this many pixels of the bottom, new messages keep the list scrolled to the bottom. */
const STICK_TO_BOTTOM_PX = 80;
/** How long a message opened from a link stays highlighted. */
const HIGHLIGHT_MS = 3_000;

type Props = {
  workspaceSlug: string;
  channelId: string;
  /** Shown above the first message once there is nothing older. */
  intro: React.ReactNode;
};

/** Where the list stands: the height of its content, and the first row on screen with its distance from the top. */
type ScrollPosition = { contentHeight: number; row: Element | null; rowTop: number };

function readScrollPosition(root: HTMLElement, content: HTMLElement): ScrollPosition {
  const viewportTop = root.getBoundingClientRect().top;
  const contentHeight = content.offsetHeight;
  for (const row of root.querySelectorAll("[data-message-id]")) {
    const { top, bottom } = row.getBoundingClientRect();
    if (bottom > viewportTop) return { contentHeight, row, rowTop: top - viewportTop };
  }
  return { contentHeight, row: null, rowTop: 0 };
}

function DayDivider({ day }: { day: string }) {
  const { t } = useTranslation();
  const today = localDay(new Date().toISOString());
  const yesterday = localDay(new Date(Date.now() - 86_400_000).toISOString());
  const label =
    day === today
      ? t("messages.day.today")
      : day === yesterday
        ? t("messages.day.yesterday")
        : renderFormattedDate(day);
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 px-4 py-2">
      <span className="h-px flex-1 bg-layer-3" />
      <span className="text-caption-md-medium text-tertiary">{label}</span>
      <span className="h-px flex-1 bg-layer-3" />
    </div>
  );
}

/**
 * A channel's messages, oldest at the top. Scrolling to the top loads the page before (`before`) until `has_more`
 * is false, keeping what was on screen in place. New messages keep it at the bottom if it already was.
 */
export const ChatMessageList = observer(function ChatMessageList({ workspaceSlug, channelId, intro }: Props) {
  const { t } = useTranslation();
  const chat = useChat();
  const messages = chat.getChannelMessages(channelId);
  const state = chat.getMessagesState(channelId);
  const pending = chat.getPendingMessages(channelId);
  const rows = buildMessageRows(messages);

  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const position = useRef<ScrollPosition>({ contentHeight: 0, row: null, rowTop: 0 });

  const firstId = messages[0]?.id;
  const lastId = messages[messages.length - 1]?.id;
  const targetMessageId = useSearchParams().get("message");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const loaded = !!state?.loaded;
  const hasMoreOlder = !!state?.hasMoreOlder;
  const loadingOlder = !!state?.loadingOlder;

  // Scrolled to the top: fetch the page before.
  useEffect(() => {
    const root = scrollRef.current;
    const target = topRef.current;
    if (!root || !target || !hasMoreOlder || typeof IntersectionObserver === "undefined") return;
    const intersection = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void chat.loadOlderMessages(channelId);
      },
      { root, rootMargin: "200px 0px 0px 0px" }
    );
    intersection.observe(target);
    return () => intersection.disconnect();
  }, [chat, channelId, hasMoreOlder, loadingOlder]);

  // Stay at the bottom if already there; otherwise keep the same messages on screen, whatever changed above them.
  const holdPosition = useCallback(() => {
    const root = scrollRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const { row, rowTop } = position.current;
    if (atBottom.current) {
      root.scrollTop = root.scrollHeight;
    } else if (row?.isConnected) {
      // Measured rather than assumed: browsers with scroll anchoring may already have made this correction.
      const moved = row.getBoundingClientRect().top - root.getBoundingClientRect().top - rowTop;
      if (moved) root.scrollTop += moved;
    }
    position.current = readScrollPosition(root, content);
  }, []);

  useLayoutEffect(holdPosition, [holdPosition, firstId, lastId, messages.length, pending.length]);

  // Message bodies are editors that render after their row does, so the content grows after the commit above.
  const observeContent = useCallback(
    (content: HTMLDivElement | null) => {
      contentRef.current = content;
      if (!content) return;
      const resizeObserver = new ResizeObserver(holdPosition);
      resizeObserver.observe(content);
      return () => resizeObserver.disconnect();
    },
    [holdPosition]
  );

  // Opened from a link to one message (an inbox mention): find it, then bring it into view.
  useEffect(() => {
    if (!loaded || !targetMessageId) return;
    let cancelled = false;
    atBottom.current = false;
    const reveal = async () => {
      const found = await chat.revealMessage(channelId, targetMessageId);
      if (cancelled) return;
      if (found) setHighlightedId(targetMessageId);
      else setToast({ type: "error", title: t("messages.errors.message_not_found") });
    };
    void reveal();
    return () => {
      cancelled = true;
    };
  }, [chat, channelId, loaded, targetMessageId, t]);

  useEffect(() => {
    if (!highlightedId) return;
    // A real ID: only one the store found gets here, so it's safe in a selector.
    scrollRef.current?.querySelector(`[data-message-id="${highlightedId}"]`)?.scrollIntoView?.({ block: "center" });
    // Now, not on the scroll event: bodies still rendering would otherwise put the list back where it was.
    if (scrollRef.current && contentRef.current) {
      position.current = readScrollPosition(scrollRef.current, contentRef.current);
    }
    const timer = setTimeout(() => setHighlightedId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  if (!state || (state.loading && !state.loaded)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (state.error && !state.loaded) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-body-sm-regular text-secondary">{t("messages.errors.load_messages_failed")}</p>
        <Button
          variant="secondary"
          size="sm"
          stretch="auto"
          label={t("messages.errors.retry")}
          onClick={() => void chat.openChannel(channelId).catch(() => undefined)}
        />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-label={t("messages.list_label")}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2"
      onScroll={(event) => {
        const el = event.currentTarget;
        const content = contentRef.current;
        // The content changed height since this scroll was queued. That isn't the user leaving the bottom, and the
        // observer is about to run.
        if (content?.offsetHeight !== position.current.contentHeight) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
        position.current = readScrollPosition(el, content);
      }}
    >
      {/* mt-auto: a short channel sits at the bottom, next to the composer. */}
      <div ref={topRef} className="mt-auto" />
      <div ref={observeContent} className="flex flex-col">
        {hasMoreOlder ? (
          <div className="flex justify-center py-3">{loadingOlder && <Spinner />}</div>
        ) : (
          <div className="px-4 pt-6 pb-2">{intro}</div>
        )}
        {rows.map((row) =>
          row.kind === "day" ? (
            <DayDivider key={row.key} day={row.day} />
          ) : (
            <ChatMessageItem
              key={row.key}
              message={row.message}
              workspaceSlug={workspaceSlug}
              continued={row.continued}
              highlighted={row.message.id === highlightedId}
            />
          )
        )}
        {pending.map((item) => (
          <ChatPendingMessageItem key={item.localId} pending={item} workspaceSlug={workspaceSlug} />
        ))}
      </div>
    </div>
  );
});
