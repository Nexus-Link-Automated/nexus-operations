/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";

type Props = {
  /** The thread the agents' replies go in: its first message. */
  threadId: string;
  className?: string;
};

/** "Maia is responding…" while an agent that was @mentioned works on its reply in this thread. */
export const ChatAgentResponding = observer(function ChatAgentResponding({ threadId, className }: Props) {
  const { t } = useTranslation();
  const { getRespondingAgents, getAgentName } = useChat();
  const agentIds = [...new Set(getRespondingAgents(threadId).map((entry) => entry.agentId))];
  if (agentIds.length === 0) return null;
  return (
    <div role="status" className={cn("flex flex-col gap-0.5", className)}>
      {agentIds.map((agentId) => (
        <span key={agentId} className="flex items-center gap-1.5 text-caption-md-regular text-tertiary">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent-primary" />
          {t("messages.agent.responding", { name: getAgentName(agentId) ?? t("messages.agent.tag") })}
        </span>
      ))}
    </div>
  );
});
