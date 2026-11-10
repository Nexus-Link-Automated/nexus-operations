/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
// components
import { pickInitialAgent, recallAgent, rememberAgent } from "@/components/agents/helpers";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useAppRouter } from "@/hooks/use-app-router";
// local imports
import { chatErrorMessage, isChatRateLimited } from "./helpers";

type TOpenOptions = {
  /** Replace the current history entry instead of adding one (when following a redirect link). */
  replace?: boolean;
};

/**
 * Opens the member's conversation with an agent in Messages, creating it the first time. Without an agent ID it opens
 * the one they last chatted with, else the first usable one. Returns whether a conversation opened.
 */
export function useOpenAgentDm(workspaceSlug: string) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const chat = useChat();

  return useCallback(
    async (agentId?: string, options: TOpenOptions = {}): Promise<boolean> => {
      try {
        let target = agentId;
        if (!target) {
          if (!chat.availableAgents) await chat.fetchAvailableAgents();
          target = pickInitialAgent(chat.availableAgents ?? [], recallAgent(workspaceSlug));
        }
        if (!target) {
          setToast({ type: "info", title: t("messages.agent_picker.empty") });
          return false;
        }
        const channel = await chat.openAgentDm(target);
        rememberAgent(workspaceSlug, target);
        const url = `/${workspaceSlug}/messages/${channel.id}`;
        if (options.replace) router.replace(url);
        else router.push(url);
        return true;
      } catch (error) {
        setToast({
          type: "error",
          title: t("messages.errors.open_agent_dm_failed"),
          message: isChatRateLimited(error) ? t("messages.errors.rate_limited") : chatErrorMessage(error),
        });
        return false;
      }
    },
    [chat, router, t, workspaceSlug]
  );
}
