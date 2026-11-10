/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
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
import { InputField } from "@makeplane/propel/components/input-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { IUserLite } from "@plane/types";
// hooks
import { useAppRouter } from "@/hooks/use-app-router";
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
// local imports
import { chatErrorMessage, GROUP_DM_MAX_MEMBERS, isChatRateLimited } from "./helpers";
import { MemberAvatar } from "./member-avatar";

type Props = {
  workspaceSlug: string;
  onClose: () => void;
};

/** Pick one person for a DM, or several (up to the group limit) for a group DM. Opening an existing one reuses it. */
export const NewDirectMessageDialog = observer(function NewDirectMessageDialog({ workspaceSlug, onClose }: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { openDm, userId } = useChat();
  const {
    workspace: { workspaceMemberIds, getWorkspaceMemberDetails },
  } = useMember();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const maxOthers = GROUP_DM_MAX_MEMBERS - 1;

  const needle = query.trim().toLowerCase();
  // Active workspace members other than the caller, matching the search.
  const people: IUserLite[] = [];
  for (const id of workspaceMemberIds ?? []) {
    if (id === userId) continue;
    const member = getWorkspaceMemberDetails(id);
    const user = member?.member;
    if (!user || member.is_active === false) continue;
    if (needle && !`${user.display_name} ${user.first_name} ${user.last_name}`.toLowerCase().includes(needle)) continue;
    people.push(user);
  }

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, id] : current.filter((other) => other !== id)));

  const handleSubmit = async () => {
    if (selected.length === 0) return;
    setIsSubmitting(true);
    try {
      const channel = await openDm(selected);
      onClose();
      router.push(`/${workspaceSlug}/messages/${channel.id}`);
    } catch (caught) {
      setToast({
        type: "error",
        title: t("messages.errors.open_dm_failed"),
        message: isChatRateLimited(caught) ? t("messages.errors.rate_limited") : chatErrorMessage(caught),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("messages.new_dm.title")}</DialogTitle>
              <DialogDescription>{t("messages.new_dm.description", { count: maxOthers })}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-3">
              <InputField
                id="chat-dm-search"
                name="search"
                size="lg"
                orientation="vertical"
                label={t("messages.new_dm.search")}
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {people.length === 0 ? (
                <p className="py-4 text-center text-body-sm-regular text-tertiary">{t("messages.new_dm.empty")}</p>
              ) : (
                <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                  {people.map((user) => {
                    const checked = selected.includes(user.id);
                    return (
                      <li key={user.id} className="flex items-center gap-2 px-1">
                        <MemberAvatar userId={user.id} size="sm" />
                        <CheckboxField
                          size="md"
                          label={user.display_name}
                          checked={checked}
                          disabled={!checked && selected.length >= maxOthers}
                          onCheckedChange={(value) => toggle(user.id, value === true)}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </DialogBody>
        </DialogMain>
        <DialogActions>
          <Button
            variant="secondary"
            size="md"
            stretch="auto"
            label={t("common.cancel")}
            disabled={isSubmitting}
            onClick={onClose}
          />
          <Button
            variant="primary"
            size="md"
            stretch="auto"
            label={t("messages.new_dm.submit")}
            disabled={selected.length === 0}
            loading={isSubmitting}
            onClick={() => void handleSubmit()}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
});
