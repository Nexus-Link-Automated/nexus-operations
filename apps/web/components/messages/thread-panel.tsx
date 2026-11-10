/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { CloseOutline } from "@makeplane/propel/icons";
import { Spinner } from "@plane/blocks/spinner";
import { useTranslation } from "@plane/i18n";
import type { TChatChannel } from "@plane/types";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import type { TChatComposerBody } from "./composer";
import { ChatComposer } from "./composer";
import { ChatMessageItem } from "./message-item";
import { ChatMessageList } from "./message-list";

type Props = {
  workspaceSlug: string;
  channel: TChatChannel;
  parentId: string;
};

/**
 * One thread beside the conversation: its first message, then its replies, and a composer to reply with. Escape or
 * the close button closes it. Below the `lg` breakpoint it takes the conversation's place instead of sitting beside it.
 */
export const ChatThreadPanel = observer(function ChatThreadPanel({ workspaceSlug, channel, parentId }: Props) {
  const { t } = useTranslation();
  const chat = useChat();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const parent = chat.messageMap[parentId];
  const state = chat.getThreadState(parentId);
  // As in the channel: the API refuses replies from someone not in it, and in an archived channel.
  const canReply = channel.is_member && !channel.archived_at;

  // The composer takes focus as it opens. Without one, the panel's heading does, so Escape works from here.
  useEffect(() => {
    if (!canReply) headingRef.current?.focus();
  }, [canReply]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Something inside (a mention list, a dialog) that used Escape already marked it handled.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    chat.closeThread();
  };

  const send = (body: TChatComposerBody) => {
    chat.sendReply(channel.id, parentId, body).catch(() => {
      // The reply stays in the thread as failed, with retry and discard.
    });
  };

  return (
    <aside
      aria-labelledby={headingId}
      className="flex min-h-0 w-full min-w-0 flex-col border-subtle bg-surface-1 lg:w-96 lg:flex-shrink-0 lg:border-l"
      onKeyDown={handleKeyDown}
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-subtle px-4 py-2.5">
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-body-md-semibold text-primary outline-none"
        >
          {t("messages.thread.title")}
        </h2>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<CloseOutline />}
          aria-label={t("messages.thread.close")}
          onClick={() => chat.closeThread()}
        />
      </header>
      {parent ? (
        <ChatMessageList
          workspaceSlug={workspaceSlug}
          channelId={channel.id}
          parentId={parentId}
          intro={
            <div className="-mx-4 flex flex-col gap-2">
              <ChatMessageItem message={parent} workspaceSlug={workspaceSlug} continued={false} inThread />
              {parent.reply_count > 0 && (
                <div role="separator" className="flex items-center gap-3 px-4 pt-1">
                  <span className="text-caption-md-medium text-tertiary">
                    {t("messages.message.replies", { count: parent.reply_count })}
                  </span>
                  <span className="h-px flex-1 bg-layer-3" />
                </div>
              )}
            </div>
          }
        />
      ) : state?.error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-body-sm-regular text-secondary">{t("messages.errors.message_not_found")}</p>
          <Button
            variant="secondary"
            size="sm"
            stretch="auto"
            label={t("messages.errors.retry")}
            onClick={() => void chat.openThread(channel.id, parentId)}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
      {canReply && parent && (
        <div className="flex-shrink-0 px-4 pb-4">
          <ChatComposer
            workspaceSlug={workspaceSlug}
            channelId={channel.id}
            parentId={parentId}
            placeholder={t("messages.thread.reply_placeholder")}
            onSend={send}
          />
        </div>
      )}
    </aside>
  );
});
