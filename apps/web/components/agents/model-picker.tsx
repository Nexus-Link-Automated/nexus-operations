/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { ChevronDownOutline, KeyOutline, SettingsOutline } from "@makeplane/propel/icons";
import { selectChoices } from "@plane/acp-client";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// components
import { Button } from "@/components/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/shadcn/dropdown-menu";
// hooks
import { useAgentChat } from "@/hooks/store/use-agent-chat";
import { useAppRouter } from "@/hooks/use-app-router";
// local imports
import { AgentAdapterIcon } from "./adapter-icon";
import { isAgentAvailable, rememberAgent } from "./helpers";

type Props = { className?: string };

/**
 * One menu for what the chat runs on: the agent, then the session's model. Switching agents opens
 * a new chat (the provider cannot change mid-conversation); switching models keeps the
 * conversation. Agents with no credential are shown but disabled, with where to add one.
 */
export const AgentModelPicker = observer(function AgentModelPicker({ className }: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { workspaceSlug, getWorkspaceAgents, agentId, activeAgent, modelConfig, snapshot, openChat, setModel } =
    useAgentChat();
  const agents = workspaceSlug ? (getWorkspaceAgents(workspaceSlug) ?? []) : [];
  const models = modelConfig?.type === "select" ? selectChoices(modelConfig) : [];
  const currentModel = models.find((choice) => choice.value === modelConfig?.currentValue);
  const modelsLocked = snapshot?.status !== "ready" || !!snapshot?.prompting;
  if (!activeAgent || !workspaceSlug) return null;

  const showAgents = agents.length > 1 || !isAgentAvailable(activeAgent);
  const label = [showAgents ? activeAgent.name : null, currentModel?.name].filter(Boolean).join(" · ");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 max-w-full min-w-0 gap-1.5 px-2 text-caption-md-regular text-secondary", className)}
            aria-label={t("agents.picker.trigger_label", { selection: label || activeAgent.name })}
          />
        }
      >
        <AgentAdapterIcon adapter={activeAgent.adapter} className="size-3.5" />
        <span className="truncate">{label || activeAgent.name}</span>
        <ChevronDownOutline className="size-3 text-tertiary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        {showAgents && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("agents.picker.label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={agentId ?? ""}
              onValueChange={(next: string) => {
                if (!next || next === agentId) return;
                rememberAgent(workspaceSlug, next);
                void openChat(workspaceSlug, next);
              }}
            >
              {agents.map((agent) => {
                const available = isAgentAvailable(agent);
                return (
                  <DropdownMenuRadioItem key={agent.id} value={agent.id} disabled={!available} className="items-start">
                    <AgentAdapterIcon adapter={agent.adapter} className="mt-0.5" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-primary">{agent.name}</span>
                      {available ? (
                        agent.description && (
                          <span className="line-clamp-2 text-caption-sm-regular text-tertiary">
                            {agent.description}
                          </span>
                        )
                      ) : (
                        <span className="flex items-center gap-1 text-caption-sm-regular text-tertiary">
                          <KeyOutline className="size-3" />
                          {t("agents.picker.unavailable")}
                        </span>
                      )}
                    </div>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            <p className="px-2 pb-1 text-caption-sm-regular text-tertiary">{t("agents.picker.switch_hint")}</p>
          </DropdownMenuGroup>
        )}
        {showAgents && models.length > 0 && <DropdownMenuSeparator />}
        {models.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("agents.model.label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={modelConfig?.currentValue ?? ""}
              onValueChange={(next: string) => {
                if (next && next !== modelConfig?.currentValue) void setModel(next);
              }}
            >
              {models.map((choice) => (
                <DropdownMenuRadioItem key={choice.value} value={choice.value} disabled={modelsLocked}>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-primary">{choice.name}</span>
                    {choice.description && (
                      <span className="line-clamp-2 text-caption-sm-regular text-tertiary">{choice.description}</span>
                    )}
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        {agents.some((agent) => !isAgentAvailable(agent)) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push(`/${workspaceSlug}/settings/ai-providers/`)}>
              <SettingsOutline />
              {t("agents.picker.manage_providers")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
