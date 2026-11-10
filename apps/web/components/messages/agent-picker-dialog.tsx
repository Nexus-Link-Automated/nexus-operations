/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { Spinner } from "@plane/blocks/spinner";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
// components
import { rememberAgent } from "@/components/agents/helpers";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useAppRouter } from "@/hooks/use-app-router";
// local imports
import { chatErrorMessage, isChatRateLimited } from "./helpers";
import { ChatAgentAvatar } from "./member-avatar";

type Props = {
  workspaceSlug: string;
  onClose: () => void;
};

/**
 * Pick an agent from the registry to talk to. Its conversation is opened, or created the first time; everything sent
 * there goes to the agent, which works with the person's permissions.
 */
export const AgentPickerDialog = observer(function AgentPickerDialog({ workspaceSlug, onClose }: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { availableAgents, fetchAvailableAgents, openAgentDm } = useChat();
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    fetchAvailableAgents().catch(() => setFailed(true));
  }, [fetchAvailableAgents]);

  const open = async (agentId: string) => {
    setOpening(agentId);
    try {
      const channel = await openAgentDm(agentId);
      rememberAgent(workspaceSlug, agentId);
      onClose();
      router.push(`/${workspaceSlug}/messages/${channel.id}`);
    } catch (caught) {
      setToast({
        type: "error",
        title: t("messages.errors.open_agent_dm_failed"),
        message: isChatRateLimited(caught) ? t("messages.errors.rate_limited") : chatErrorMessage(caught),
      });
    } finally {
      setOpening(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen && !opening) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("messages.agent_picker.title")}</DialogTitle>
              <DialogDescription>{t("messages.agent_picker.description")}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            {availableAgents === null ? (
              failed ? (
                <p className="py-4 text-center text-body-sm-regular text-danger-primary">
                  {t("messages.agent_picker.load_failed")}
                </p>
              ) : (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              )
            ) : availableAgents.length === 0 ? (
              <p className="py-4 text-center text-body-sm-regular text-tertiary">{t("messages.agent_picker.empty")}</p>
            ) : (
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {availableAgents.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-layer-transparent-hover disabled:opacity-60"
                      disabled={!!opening}
                      onClick={() => void open(agent.id)}
                    >
                      <ChatAgentAvatar adapter={agent.adapter} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm-medium text-primary">{agent.name}</span>
                        {agent.description && (
                          <span className="block truncate text-caption-md-regular text-tertiary">
                            {agent.description}
                          </span>
                        )}
                      </span>
                      {opening === agent.id && <Spinner />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogMain>
        <DialogActions>
          <Button
            variant="secondary"
            size="md"
            stretch="auto"
            label={t("common.cancel")}
            disabled={!!opening}
            onClick={onClose}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
});
