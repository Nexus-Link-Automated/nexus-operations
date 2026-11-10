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
import { CloseOutline } from "@makeplane/propel/icons";
import { Spinner } from "@plane/blocks/spinner";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { ChatService } from "@plane/services";
import type { IUserLite, TChatChannel, TChatChannelMember } from "@plane/types";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
// local imports
import { chatErrorMessage } from "./helpers";
import { MemberAvatar } from "./member-avatar";

const chatService = new ChatService();

type Props = {
  workspaceSlug: string;
  channel: TChatChannel;
  onClose: () => void;
};

/**
 * Who is in a named channel. Members can add people from the workspace, and channel or workspace admins can remove
 * them, as the API allows. The channel's member count follows from the member events.
 */
export const ChannelMembersDialog = observer(function ChannelMembersDialog({ workspaceSlug, channel, onClose }: Props) {
  const { t } = useTranslation();
  const { me, userId } = useChat();
  const {
    getUserDetails,
    workspace: { workspaceMemberIds, getWorkspaceMemberDetails },
  } = useMember();
  const [members, setMembers] = useState<TChatChannelMember[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const canAdd = channel.is_member && !channel.archived_at;
  const canRemove = canAdd && (channel.my_role === "admin" || !!me?.is_workspace_admin);
  const nameOf = (id: string) => getUserDetails(id)?.display_name || t("messages.unknown_member");

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setMembers(await chatService.listMembers(workspaceSlug, channel.id));
    } catch {
      setLoadFailed(true);
    }
  }, [workspaceSlug, channel.id]);

  useEffect(() => {
    void load();
  }, [load]);

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
      await chatService.addMembers(workspaceSlug, channel.id, selected);
      setSelected([]);
      setQuery("");
      await load();
    } catch (caught) {
      setToast({ type: "error", title: t("messages.errors.add_members_failed"), message: chatErrorMessage(caught) });
    } finally {
      setIsAdding(false);
    }
  };

  const remove = async (memberId: string) => {
    setRemoving(memberId);
    try {
      await chatService.removeMember(workspaceSlug, channel.id, memberId);
      await load();
    } catch (caught) {
      setToast({ type: "error", title: t("messages.errors.remove_member_failed"), message: chatErrorMessage(caught) });
    } finally {
      setRemoving(null);
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
                    onClick={() => void load()}
                  />
                </div>
              ) : members === null ? (
                <div className="flex justify-center py-4">
                  <Spinner />
                </div>
              ) : (
                <ul aria-label={t("messages.members.title")} className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                  {members.map((member) => {
                    const name = nameOf(member.user);
                    return (
                      <li key={member.user} className="flex items-center gap-2 px-1 py-0.5">
                        <MemberAvatar userId={member.user} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-body-sm-regular text-primary">
                          {name}
                          {member.user === userId && <span className="text-tertiary"> ({t("common.you")})</span>}
                        </span>
                        {member.role === "admin" && (
                          <span className="text-caption-md-medium text-tertiary">{t("messages.members.admin")}</span>
                        )}
                        {canRemove && member.user !== userId && (
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
              )}
              {canAdd && members !== null && (
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
          {canAdd && (
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
