/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { Select, SelectContent, SelectItem, SelectList, SelectTrigger } from "@makeplane/propel/components/select";
import {
  CircleDashedOutline,
  CloseCircleOutline,
  ShieldOutline,
  StopOutline,
  TickCircleOutline,
  WarningCircleOutline,
} from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { AGENT_PERMISSION_LEVELS, getAgentPermissionRank } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { ChatServiceError } from "@plane/services";
import type {
  TAgentPermissionLevel,
  TChatAgentPermissionOption,
  TChatAgentPermissionRequest,
  TChatAgentToolCall,
  TChatChannel,
} from "@plane/types";
import { cn } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { chatErrorMessage } from "./helpers";

type ChannelProps = { channel: TChatChannel };

/**
 * The level the agent works at in this DM: the person's choice, up to the registry's maximum. A new level applies from
 * the next message on.
 */
export const AgentDmLevelSelect = observer(function AgentDmLevelSelect({ channel }: ChannelProps) {
  const { t } = useTranslation();
  const { setAgentDmLevel } = useChat();
  const [saving, setSaving] = useState(false);
  const dm = channel.agent_dm;
  if (!dm?.permission_level || !dm.max_permission_level) return null;
  const max = getAgentPermissionRank(dm.max_permission_level);
  const levels = AGENT_PERMISSION_LEVELS.filter((level) => getAgentPermissionRank(level) <= max);
  const label = (level: TAgentPermissionLevel) => {
    const name = t(`agents.permission.levels.${level}.name`);
    return level === dm.default_permission_level ? t("messages.agent_dm.level_default", { name }) : name;
  };

  const change = async (level: TAgentPermissionLevel) => {
    setSaving(true);
    try {
      await setAgentDmLevel(channel.id, level);
    } catch (error) {
      setToast({ type: "error", title: t("messages.agent_dm.errors.level_failed"), message: chatErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Select<string>
      items={levels.map((level) => ({ value: level, label: label(level) }))}
      value={dm.permission_level}
      disabled={saving || !!dm.read_only_reason}
      onValueChange={(level) => {
        if (level && level !== dm.permission_level) void change(level as TAgentPermissionLevel);
      }}
    >
      <SelectTrigger
        size="md"
        variant="ghost"
        width="fit"
        icon={<ShieldOutline />}
        aria-label={t("messages.agent_dm.level_label")}
      />
      <SelectContent side="bottom" align="end">
        <SelectList>
          {levels.map((level) => (
            <SelectItem
              key={level}
              value={level}
              size="md"
              label={label(level)}
              description={t(`agents.permission.levels.${level}.description`)}
            />
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
});

/** Stops the agent's running turn (ACP `session/cancel`); what it wrote so far stays. */
export const AgentDmStopButton = observer(function AgentDmStopButton({ channel }: ChannelProps) {
  const { t } = useTranslation();
  const { stopAgentTurn } = useChat();
  const [stopping, setStopping] = useState(false);
  if (!channel.agent_dm?.responding) return null;

  const stop = async () => {
    setStopping(true);
    try {
      await stopAgentTurn(channel.id);
    } catch (error) {
      setToast({ type: "error", title: t("messages.agent_dm.errors.stop_failed"), message: chatErrorMessage(error) });
    } finally {
      setStopping(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      stretch="auto"
      icon={<StopOutline />}
      label={t("messages.agent_dm.stop")}
      loading={stopping}
      onClick={() => void stop()}
    />
  );
});

/** Why the conversation takes no new messages, in place of the composer. */
export function AgentDmReadOnlyNotice({ channel, name }: ChannelProps & { name: string }) {
  const { t } = useTranslation();
  const reason = channel.agent_dm?.read_only_reason;
  if (!reason) return null;
  return (
    <div
      role="note"
      className="flex items-center gap-2 rounded-md bg-layer-2 px-3 py-2 text-body-sm-regular text-secondary"
    >
      <WarningCircleOutline className="size-4 flex-shrink-0" aria-hidden />
      {t(`messages.agent_dm.read_only.${reason}`, { name })}
    </div>
  );
}

const OPTION_VARIANTS = {
  allow_once: "primary",
  allow_always: "secondary",
  reject_once: "danger-outline",
  reject_always: "danger-outline",
} as const;

const OPTION_KEYS = {
  allow_once: "agents.permission_prompt.allow_once",
  allow_always: "agents.permission_prompt.allow_always",
  reject_once: "agents.permission_prompt.reject_once",
  reject_always: "agents.permission_prompt.reject_always",
} as const;

type PromptProps = {
  channelId: string;
  agentName: string;
  request: TChatAgentPermissionRequest;
};

/** One tool call waiting for approval: its title and the agent's options. The turn waits until it is answered. */
const AgentDmPermissionPrompt = observer(function AgentDmPermissionPrompt({
  channelId,
  agentName,
  request,
}: PromptProps) {
  const { t } = useTranslation();
  const { answerAgentPermission } = useChat();
  const [answering, setAnswering] = useState<string | null>(null);
  const headingId = `agent-permission-${request.id}`;

  const answer = async (option: TChatAgentPermissionOption) => {
    setAnswering(option.option_id);
    try {
      await answerAgentPermission(channelId, request.id, option.option_id);
    } catch (error) {
      const status = error instanceof ChatServiceError ? error.status : 0;
      setToast({
        type: "error",
        title: t("messages.agent_dm.permission.answer_failed"),
        message:
          status === 409
            ? t("messages.agent_dm.permission.expired")
            : status === 503
              ? t("messages.agent_dm.permission.unavailable")
              : chatErrorMessage(error),
      });
    } finally {
      setAnswering(null);
    }
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-md border border-strong bg-layer-1 p-3"
    >
      <div className="flex items-center gap-2">
        <ShieldOutline className="size-4 flex-shrink-0 text-accent-primary" aria-hidden />
        <p id={headingId} className="text-body-xs-medium text-primary">
          {t("messages.agent_dm.permission.title", { name: agentName })}
        </p>
      </div>
      <p className="text-body-sm-regular text-secondary">
        {request.title.trim() || t("messages.agent_dm.permission.untitled")}
      </p>
      <div className="flex flex-wrap gap-2">
        {request.options.map((option) => (
          <Button
            key={option.option_id}
            variant={OPTION_VARIANTS[option.kind] ?? "secondary"}
            size="sm"
            stretch="auto"
            label={OPTION_KEYS[option.kind] ? t(OPTION_KEYS[option.kind]) : option.name}
            loading={answering === option.option_id}
            disabled={!!answering}
            onClick={() => void answer(option)}
          />
        ))}
      </div>
    </div>
  );
});

/** The tool calls in this agent DM waiting for its person's approval, above the composer. */
export const AgentDmPermissionPrompts = observer(function AgentDmPermissionPrompts({
  channel,
  agentName,
}: ChannelProps & { agentName: string }) {
  const { getAgentPermissions } = useChat();
  const requests = getAgentPermissions(channel.id);
  if (requests.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 pb-2">
      {requests.map((request) => (
        <AgentDmPermissionPrompt key={request.id} channelId={channel.id} agentName={agentName} request={request} />
      ))}
    </div>
  );
});

const TOOL_STATUS_ICONS = {
  pending: CircleDashedOutline,
  in_progress: CircleDashedOutline,
  completed: TickCircleOutline,
  failed: CloseCircleOutline,
} as const;

/** The tool calls an agent made for a reply: titles and how each went, nothing of their input or output. */
export function ChatAgentToolCalls({ calls }: { calls: TChatAgentToolCall[] | null }) {
  const { t } = useTranslation();
  if (!calls?.length) return null;
  return (
    <ul aria-label={t("messages.agent_dm.tool_calls")} className="mt-1 flex flex-col gap-0.5">
      {calls.map((call) => {
        const Icon = TOOL_STATUS_ICONS[call.status] ?? CircleDashedOutline;
        const status = t(`messages.agent_dm.tool_status.${call.status}`);
        return (
          <li key={call.id} title={status} className="flex items-center gap-1.5 text-caption-md-regular text-tertiary">
            <Icon
              className={cn("size-3.5 flex-shrink-0", {
                "text-success-primary": call.status === "completed",
                "text-danger-primary": call.status === "failed",
                "animate-spin": call.status === "in_progress",
              })}
              aria-hidden
            />
            <span className="min-w-0 truncate">{call.title || t("messages.agent_dm.permission.untitled")}</span>
            <span className="sr-only">{status}</span>
          </li>
        );
      })}
    </ul>
  );
}
