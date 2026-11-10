/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { CheckboxField } from "@makeplane/propel/components/checkbox-field";
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
import { IconButton } from "@makeplane/propel/components/icon-button";
import { InputField } from "@makeplane/propel/components/input-field";
import { RadioGroupField, RadioGroupFieldOption } from "@makeplane/propel/components/radio-group-field";
import { AddOutline, CloseOutline } from "@makeplane/propel/icons";
import { Spinner } from "@plane/blocks/spinner";
import { setToast } from "@plane/blocks/toast";
import { AGENT_PERMISSION_LEVELS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { IUserLite, TAgentPermissionLevel, TChatChannel, TChatChannelAgent } from "@plane/types";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
// local imports
import { chatErrorMessage } from "./helpers";
import { ChatAgentAvatar, ChatAgentTag, MemberAvatar } from "./member-avatar";

type Props = {
  channel: TChatChannel;
  onClose: () => void;
};

/**
 * The most an agent may do in a channel, whatever the registry allows: nobody can answer its permission prompts there
 * yet, and other members' messages are part of what it reads. The API caps it the same way.
 */
const CHANNEL_MAX_LEVEL: TAgentPermissionLevel = "ask_writes";

const lower = (a: TAgentPermissionLevel, b: TAgentPermissionLevel): TAgentPermissionLevel =>
  AGENT_PERMISSION_LEVELS.indexOf(a) <= AGENT_PERMISSION_LEVELS.indexOf(b) ? a : b;

/** The levels up to `max` and the channel cap, least permissive first: what may be chosen for this channel. */
const levelsUpTo = (max: TAgentPermissionLevel): TAgentPermissionLevel[] =>
  AGENT_PERMISSION_LEVELS.slice(0, AGENT_PERMISSION_LEVELS.indexOf(lower(max, CHANNEL_MAX_LEVEL)) + 1);

/** The level an agent starts at in a channel when none is chosen. */
const defaultLevel = (agent: {
  default_permission_level: TAgentPermissionLevel;
  max_permission_level: TAgentPermissionLevel;
}) => lower(agent.default_permission_level, lower(agent.max_permission_level, CHANNEL_MAX_LEVEL));

/**
 * Who is in a named channel: its agents and its people. Members can add people from the workspace, and channel or
 * workspace admins can remove them. A channel or workspace admin can add and remove agents; adding one also needs
 * someone who may run agents, so never a guest. The store keeps both lists current while this is open, and the
 * channel's member count follows from the member events.
 */
export const ChannelMembersDialog = observer(function ChannelMembersDialog({ channel, onClose }: Props) {
  const { t } = useTranslation();
  const chat = useChat();
  const {
    getUserDetails,
    workspace: { workspaceMemberIds, getWorkspaceMemberDetails },
  } = useMember();
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [addingAgent, setAddingAgent] = useState(false);
  const [removingAgent, setRemovingAgent] = useState<string | null>(null);
  const archived = !!channel.archived_at;
  const isAdmin = channel.my_role === "admin" || !!chat.me?.is_workspace_admin;
  const canAddPeople = channel.is_member && !archived;
  const canRemovePeople = canAddPeople && isAdmin;
  // What the API checks for agents: a channel admin or a workspace admin (`is_channel_admin`), and for adding,
  // someone who may run agents (`can_add_agents`).
  const canManageAgents = !archived && isAdmin;
  const canAddAgents = canManageAgents && !!chat.me?.can_add_agents;
  const members = chat.channelMembers[channel.id];
  const agents = chat.channelAgents[channel.id];
  const nameOf = (id: string) => getUserDetails(id)?.display_name || t("messages.unknown_member");

  const load = useCallback(() => {
    setLoadFailed(false);
    Promise.all([chat.fetchChannelMembers(channel.id), chat.fetchChannelAgents(channel.id)]).catch(() =>
      setLoadFailed(true)
    );
  }, [chat, channel.id]);

  useEffect(() => {
    load();
    return () => chat.forgetChannelMembers(channel.id);
  }, [chat, channel.id, load]);

  const inChannel = new Set((members ?? []).map((member) => member.user));
  const needle = query.trim().toLowerCase();
  // Active workspace members not in the channel yet, matching the search.
  const candidates: IUserLite[] = [];
  for (const id of workspaceMemberIds ?? []) {
    if (inChannel.has(id)) continue;
    const member = getWorkspaceMemberDetails(id);
    const user = member?.member;
    if (!user || member.is_active === false) continue;
    if (needle && !`${user.display_name} ${user.first_name} ${user.last_name}`.toLowerCase().includes(needle)) continue;
    candidates.push(user);
  }

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, id] : current.filter((other) => other !== id)));

  const add = async () => {
    if (selected.length === 0) return;
    setIsAdding(true);
    try {
      await chat.addChannelMembers(channel.id, selected);
      setSelected([]);
      setQuery("");
    } catch (caught) {
      setToast({ type: "error", title: t("messages.errors.add_members_failed"), message: chatErrorMessage(caught) });
    } finally {
      setIsAdding(false);
    }
  };

  const remove = async (memberId: string) => {
    setRemoving(memberId);
    try {
      await chat.removeChannelMember(channel.id, memberId);
    } catch (caught) {
      setToast({ type: "error", title: t("messages.errors.remove_member_failed"), message: chatErrorMessage(caught) });
    } finally {
      setRemoving(null);
    }
  };

  const removeAgent = async (agent: TChatChannelAgent) => {
    setRemovingAgent(agent.agent);
    try {
      await chat.removeChannelAgent(channel.id, agent.agent);
    } catch (caught) {
      setToast({ type: "error", title: t("messages.errors.remove_agent_failed"), message: chatErrorMessage(caught) });
    } finally {
      setRemovingAgent(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isAdding) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("messages.members.title")}</DialogTitle>
              <DialogDescription>{t("messages.members.description", { name: channel.name })}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              {loadFailed ? (
                <div className="flex flex-col items-center gap-2 py-4">
                  <p className="text-body-sm-regular text-secondary">{t("messages.errors.load_members_failed")}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    stretch="auto"
                    label={t("messages.errors.retry")}
                    onClick={load}
                  />
                </div>
              ) : !members || !agents ? (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              ) : (
                <>
                  <section aria-labelledby="chat-members-agents" className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 id="chat-members-agents" className="text-body-sm-semibold text-primary">
                        {t("messages.members.agents")}
                      </h3>
                      {canAddAgents && !addingAgent && (
                        <Button
                          variant="ghost"
                          size="sm"
                          stretch="auto"
                          icon={<AddOutline />}
                          label={t("messages.members.add_agent")}
                          onClick={() => setAddingAgent(true)}
                        />
                      )}
                    </div>
                    {addingAgent && <AddAgentForm channel={channel} onDone={() => setAddingAgent(false)} />}
                    {agents.length === 0 && !addingAgent && (
                      <p className="text-body-sm-regular text-tertiary">{t("messages.members.no_agents")}</p>
                    )}
                    {agents.length > 0 && (
                      <ul className="flex flex-col gap-1">
                        {agents.map((agent) => (
                          <li key={agent.id} className="flex items-center gap-2 py-1">
                            <ChatAgentAvatar adapter={agent.adapter} size="sm" />
                            <span className="truncate text-body-sm-medium text-primary">{agent.name}</span>
                            <ChatAgentTag />
                            {!agent.is_available && (
                              <span className="text-caption-sm-regular text-tertiary">
                                {t("messages.members.unavailable")}
                              </span>
                            )}
                            <span className="ml-auto flex-shrink-0 text-caption-md-regular text-tertiary">
                              {t(`agents.permission.levels.${agent.permission_level}.name`)}
                            </span>
                            {canManageAgents && (
                              <IconButton
                                variant="ghost"
                                size="sm"
                                icon={<CloseOutline />}
                                aria-label={t("messages.members.remove_agent", { name: agent.name })}
                                disabled={removingAgent === agent.agent}
                                onClick={() => void removeAgent(agent)}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* What a mention of one does, and with whose permissions, before anyone tries it. */}
                    <p className="text-caption-md-regular text-tertiary">{t("messages.members.agents_how")}</p>
                  </section>

                  <section aria-labelledby="chat-members-people" className="flex flex-col gap-2">
                    <h3 id="chat-members-people" className="text-body-sm-semibold text-primary">
                      {t("messages.members.people")}
                    </h3>
                    <ul aria-labelledby="chat-members-people" className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                      {members.map((member) => {
                        const name = nameOf(member.user);
                        return (
                          <li key={member.user} className="flex items-center gap-2 px-1 py-0.5">
                            <MemberAvatar userId={member.user} size="sm" />
                            <span className="min-w-0 flex-1 truncate text-body-sm-regular text-primary">
                              {name}
                              {member.user === chat.userId && (
                                <span className="text-tertiary"> ({t("common.you")})</span>
                              )}
                            </span>
                            {member.role === "admin" && (
                              <span className="text-caption-md-medium text-tertiary">
                                {t("messages.members.admin")}
                              </span>
                            )}
                            {canRemovePeople && member.user !== chat.userId && (
                              <IconButton
                                variant="ghost"
                                size="sm"
                                icon={<CloseOutline />}
                                aria-label={t("messages.members.remove", { name })}
                                loading={removing === member.user}
                                disabled={removing !== null}
                                onClick={() => void remove(member.user)}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>

                  {canAddPeople && (
                    <section className="flex flex-col gap-2">
                      <h3 className="text-body-sm-semibold text-primary">{t("messages.members.add_title")}</h3>
                      <InputField
                        id="chat-members-search"
                        name="search"
                        size="lg"
                        orientation="vertical"
                        label={t("messages.members.search")}
                        autoComplete="off"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      {candidates.length === 0 ? (
                        <p className="py-2 text-center text-body-sm-regular text-tertiary">
                          {t("messages.members.no_candidates")}
                        </p>
                      ) : (
                        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                          {candidates.map((user) => (
                            <li key={user.id} className="flex items-center gap-2 px-1">
                              <MemberAvatar userId={user.id} size="sm" />
                              <CheckboxField
                                size="md"
                                label={user.display_name}
                                checked={selected.includes(user.id)}
                                onCheckedChange={(value) => toggle(user.id, value === true)}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </>
              )}
            </div>
          </DialogBody>
        </DialogMain>
        <DialogActions>
          <Button
            variant="secondary"
            size="md"
            stretch="auto"
            label={t("common.done")}
            disabled={isAdding}
            onClick={onClose}
          />
          {canAddPeople && (
            <Button
              variant="primary"
              size="md"
              stretch="auto"
              label={t("common.add")}
              disabled={selected.length === 0}
              loading={isAdding}
              onClick={() => void add()}
            />
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
});

type AddAgentProps = { channel: TChatChannel; onDone: () => void };

/** Pick an enabled agent from the registry and the level it works at, up to the registry's maximum for it. */
const AddAgentForm = observer(function AddAgentForm({ channel, onDone }: AddAgentProps) {
  const { t } = useTranslation();
  const chat = useChat();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [level, setLevel] = useState<TAgentPermissionLevel | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    chat.fetchAvailableAgents().catch(() => setLoadFailed(true));
  }, [chat]);

  const inChannel = new Set((chat.channelAgents[channel.id] ?? []).map((agent) => agent.agent));
  const choices = (chat.availableAgents ?? []).filter((agent) => !inChannel.has(agent.id));
  const chosen = choices.find((agent) => agent.id === agentId);

  const submit = async () => {
    if (!chosen) return;
    setError(undefined);
    setSubmitting(true);
    try {
      await chat.addChannelAgent(channel.id, {
        agent_id: chosen.id,
        permission_level: level ?? defaultLevel(chosen),
      });
      onDone();
    } catch (caught) {
      const message = chatErrorMessage(caught);
      if (message) setError(message);
      else setToast({ type: "error", title: t("messages.errors.add_agent_failed") });
    } finally {
      setSubmitting(false);
    }
  };

  if (loadFailed) {
    return (
      <p role="alert" className="text-body-sm-regular text-danger-primary">
        {t("messages.members.agents_load_failed")}
      </p>
    );
  }
  if (!chat.availableAgents) return null;

  return (
    <form
      noValidate
      aria-label={t("messages.members.add_agent")}
      className="flex flex-col gap-3 rounded-md border border-subtle p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {choices.length === 0 ? (
        <p className="text-body-sm-regular text-tertiary">{t("messages.members.no_available_agents")}</p>
      ) : (
        <RadioGroupField
          name="agent"
          label={t("messages.members.choose_agent")}
          size="md"
          density="compact"
          value={agentId ?? ""}
          onValueChange={(value) => {
            setAgentId(value || null);
            setLevel(null);
          }}
        >
          {choices.map((agent) => (
            <RadioGroupFieldOption
              key={agent.id}
              value={agent.id}
              label={agent.name}
              {...(agent.description ? { description: agent.description } : {})}
            />
          ))}
        </RadioGroupField>
      )}
      {chosen && (
        <RadioGroupField
          name="permission_level"
          label={t("messages.members.permission_level")}
          size="md"
          density="compact"
          value={level ?? defaultLevel(chosen)}
          onValueChange={(value) => setLevel(value as TAgentPermissionLevel)}
        >
          {levelsUpTo(chosen.max_permission_level).map((id) => (
            <RadioGroupFieldOption
              key={id}
              value={id}
              label={t(`agents.permission.levels.${id}.name`)}
              description={t(`agents.permission.levels.${id}.description`)}
            />
          ))}
        </RadioGroupField>
      )}
      {chosen && (
        <p
          className={
            channel.kind === "private"
              ? "rounded-md bg-warning-subtle px-3 py-2 text-body-sm-regular text-primary"
              : "text-body-sm-regular text-secondary"
          }
        >
          {channel.kind === "private"
            ? t("messages.members.private_notice", { name: chosen.name })
            : t("messages.members.public_notice", { name: chosen.name })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-caption-md-regular text-danger-primary">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          stretch="auto"
          label={t("common.cancel")}
          disabled={submitting}
          onClick={onDone}
        />
        <Button
          variant="primary"
          size="sm"
          stretch="auto"
          type="submit"
          label={t("messages.members.add")}
          disabled={!chosen}
          loading={submitting}
        />
      </div>
    </form>
  );
});
