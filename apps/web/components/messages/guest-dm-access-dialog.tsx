/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
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
import { SwitchField } from "@makeplane/propel/components/switch-field";
import { Spinner } from "@plane/blocks/spinner";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { ChatService } from "@plane/services";
import { EUserWorkspaceRoles } from "@plane/types";
import type { IUserLite } from "@plane/types";
// hooks
import { useMember } from "@/hooks/store/use-member";
// local imports
import { chatErrorMessage } from "./helpers";
import { MemberAvatar } from "./member-avatar";

const chatService = new ChatService();

type Props = {
  workspaceSlug: string;
  onClose: () => void;
};

/** Workspace admins choose which guests may start DMs. Members and admins always can. */
export const GuestDmAccessDialog = observer(function GuestDmAccessDialog({ workspaceSlug, onClose }: Props) {
  const { t } = useTranslation();
  const {
    workspace: { workspaceMemberIds, getWorkspaceMemberDetails },
  } = useMember();
  const [granted, setGranted] = useState<Set<string> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const grants = await chatService.listGuestDmAccess(workspaceSlug);
      setGranted(new Set(grants.filter((grant) => grant.can_open_dms).map((grant) => grant.user)));
    } catch {
      setLoadFailed(true);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const guests: IUserLite[] = [];
  for (const id of workspaceMemberIds ?? []) {
    const member = getWorkspaceMemberDetails(id);
    if (!member?.member || member.is_active === false || member.role !== EUserWorkspaceRoles.GUEST) continue;
    guests.push(member.member);
  }

  const setAccess = async (userId: string, allowed: boolean) => {
    setSaving(userId);
    try {
      if (allowed) await chatService.grantGuestDmAccess(workspaceSlug, userId);
      else await chatService.revokeGuestDmAccess(workspaceSlug, userId);
      setGranted((current) => {
        const next = new Set(current);
        if (allowed) next.add(userId);
        else next.delete(userId);
        return next;
      });
    } catch (caught) {
      setToast({
        type: "error",
        title: t("messages.errors.update_guest_access_failed"),
        message: chatErrorMessage(caught),
      });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("messages.guest_access.title")}</DialogTitle>
              <DialogDescription>{t("messages.guest_access.description")}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            {loadFailed ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <p className="text-body-sm-regular text-secondary">{t("messages.errors.load_guest_access_failed")}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  stretch="auto"
                  label={t("messages.errors.retry")}
                  onClick={() => void load()}
                />
              </div>
            ) : granted === null ? (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            ) : guests.length === 0 ? (
              <p className="py-4 text-center text-body-sm-regular text-tertiary">{t("messages.guest_access.empty")}</p>
            ) : (
              <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
                {guests.map((user) => (
                  <li key={user.id} className="flex items-center gap-2 px-1">
                    <MemberAvatar userId={user.id} size="sm" />
                    <div className="min-w-0 flex-1">
                      <SwitchField
                        name={`guest-dm-${user.id}`}
                        size="md"
                        switchSize="md"
                        label={user.display_name}
                        checked={granted.has(user.id)}
                        disabled={saving !== null}
                        onCheckedChange={(checked) => void setAccess(user.id, checked)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogMain>
        <DialogActions>
          <Button variant="secondary" size="md" stretch="auto" label={t("common.done")} onClick={onClose} />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
});
