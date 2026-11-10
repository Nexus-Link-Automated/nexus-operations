/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownOutline, ShieldOutline, TopArrowOutline } from "@makeplane/propel/icons";
import type { PendingPermission, TranscriptItem } from "@plane/acp-client";
import { useTranslation } from "@plane/i18n";
// components
import { Button } from "@/components/ui/shadcn/button";
// local imports
import { CompactionItem } from "./compaction-item";
import { MessageItem } from "./message-item";
import { NoticeItem } from "./notice-item";
import { ThoughtItem } from "./thought-item";
import { ToolCallCard } from "./tool-call-card";
import { TurnEndItem } from "./turn-end-item";

/** Within this many pixels of the bottom, new content keeps the view pinned to the bottom. */
const STICK_THRESHOLD_PX = 80;

const PERMISSION_PROMPT = "[data-permission-prompt]";

/** The first approval prompt that is not fully in view, and which way to scroll to it. */
function offscreenPrompt(container: HTMLElement): { prompt: HTMLElement; side: "above" | "below" } | undefined {
  const view = container.getBoundingClientRect();
  for (const prompt of container.querySelectorAll<HTMLElement>(PERMISSION_PROMPT)) {
    const rect = prompt.getBoundingClientRect();
    if (rect.top < view.top) return { prompt, side: "above" };
    if (rect.bottom > view.bottom) return { prompt, side: "below" };
  }
  return undefined;
}

type Props = {
  items: readonly TranscriptItem[];
  permissions: readonly PendingPermission[];
  prompting: boolean;
  onRespondToPermission: (permissionId: string, optionId: string | null) => void;
};

export function TranscriptView({ items, permissions, prompting, onRespondToPermission }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastItem = items.at(-1);
  // An approval the reader cannot see stalls the turn, so a banner points to it until it is in view.
  const [offscreenApproval, setOffscreenApproval] = useState<"above" | "below" | null>(null);
  const checkApproval = useCallback(() => {
    setOffscreenApproval((scrollRef.current && offscreenPrompt(scrollRef.current)?.side) || null);
  }, []);

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
    checkApproval();
  }, [items, permissions, checkApproval]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
    checkApproval();
  };

  const jumpToApproval = () => {
    const prompt = scrollRef.current && offscreenPrompt(scrollRef.current)?.prompt;
    if (!prompt) return;
    prompt.scrollIntoView({ block: "nearest", behavior: "smooth" });
    prompt.focus({ preventScroll: true });
  };

  const permissionFor = (toolCallId: string) =>
    permissions.find((permission) => permission.toolCall.toolCallId === toolCallId);

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="vertical-scrollbar scrollbar-md h-full overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label={t("agents.transcript.label")}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
          {items.map((item) => {
            switch (item.kind) {
              case "message":
                return <MessageItem key={item.id} item={item} />;
              case "thought":
                return <ThoughtItem key={item.id} item={item} isStreaming={prompting && item === lastItem} />;
              case "tool_call":
                return (
                  <ToolCallCard
                    key={item.id}
                    item={item}
                    {...(permissionFor(item.toolCallId) ? { permission: permissionFor(item.toolCallId) } : {})}
                    onRespondToPermission={onRespondToPermission}
                  />
                );
              case "notice":
                return <NoticeItem key={item.id} item={item} />;
              case "compaction":
                return <CompactionItem key={item.id} item={item} />;
              case "turn_end":
                return <TurnEndItem key={item.id} item={item} />;
              default:
                return null;
            }
          })}
        </div>
      </div>
      {offscreenApproval && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
          <Button
            variant="outline"
            onClick={jumpToApproval}
            className="pointer-events-auto rounded-full shadow-raised-200"
          >
            <ShieldOutline className="text-accent-primary" />
            <span className="text-primary">{t("agents.transcript.approval_needed")}</span>
            <span className="text-tertiary">{t("agents.transcript.go_to_approval")}</span>
            {offscreenApproval === "above" ? <TopArrowOutline /> : <ArrowDownOutline />}
          </Button>
        </div>
      )}
    </div>
  );
}
