/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TChatMessage } from "@plane/types";
import { cn, renderFormattedDate, renderFormattedTime } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { localDay } from "./helpers";

/** "3 replies · Last reply at 9:41 AM" under a message in the channel, opening its thread. Nothing without replies. */
export const ChatThreadSummary = observer(function ChatThreadSummary({ message }: { message: TChatMessage }) {
  const { t } = useTranslation();
  const { activeThread, openThread } = useChat();
  if (message.reply_count === 0) return null;

  const open = activeThread?.parentId === message.id;
  const lastReply = message.last_reply_at;
  const lastReplyLabel = !lastReply
    ? null
    : localDay(lastReply) === localDay(new Date().toISOString())
      ? t("messages.thread.last_reply_today", { time: renderFormattedTime(lastReply, "12-hour") })
      : t("messages.thread.last_reply_on", { date: renderFormattedDate(lastReply) ?? "" });

  return (
    <button
      type="button"
      aria-expanded={open}
      className={cn(
        "-mx-1 mt-1 flex max-w-full items-center gap-1.5 rounded-sm px-1 text-caption-md-medium hover:bg-layer-transparent-hover",
        open && "bg-layer-transparent-hover"
      )}
      onClick={() => void openThread(message.channel, message.id)}
    >
      <span className="flex-shrink-0 text-accent-primary">
        {t("messages.message.replies", { count: message.reply_count })}
      </span>
      {lastReplyLabel && (
        <>
          <span aria-hidden className="text-tertiary">
            ·
          </span>
          <span className="truncate text-caption-md-regular text-tertiary">{lastReplyLabel}</span>
        </>
      )}
    </button>
  );
});
