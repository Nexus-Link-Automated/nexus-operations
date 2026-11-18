/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
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
import { InputField } from "@makeplane/propel/components/input-field";
import { SelectField } from "@makeplane/propel/components/select-field";
import { TextAreaField } from "@makeplane/propel/components/text-area-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TBotMember, TBotMemberCreate, TBotMemberRole, TBotMemberUpdate } from "@plane/types";
// local imports
import { codingErrorMessage, codingFieldErrors } from "../coding-jobs/helpers";
import { BOT_MEMBER_ROLE, BOT_ROLES, botRoleKey } from "./helpers";

/** The API's limits. */
export const MAX_BOT_NAME_LENGTH = 60;
export const MAX_BOT_DESCRIPTION_LENGTH = 2000;

const SUBMIT_LABEL = {
  create: ["bot_members.form.create", "bot_members.form.creating"],
  edit: ["bot_members.form.save", "bot_members.form.saving"],
} as const;

type Props = {
  /** The bot to edit; left out to create one. */
  bot?: TBotMember;
  /** Creates the bot (with every field) or saves the changed fields of `bot`; a refusal is thrown. */
  onSubmit: (data: TBotMemberCreate | TBotMemberUpdate) => Promise<unknown>;
  onClose: () => void;
};

/** Creates a bot member (name, role, what it is for) or changes one. Saving an edit sends only what changed. */
export function BotMemberFormDialog({ bot, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const isEdit = !!bot;
  const [name, setName] = useState(bot?.name ?? "");
  const [role, setRole] = useState<TBotMemberRole>(
    bot && BOT_ROLES.includes(bot.role as TBotMemberRole) ? (bot.role as TBotMemberRole) : BOT_MEMBER_ROLE
  );
  const [description, setDescription] = useState(bot?.description ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const trimmedName = name.trim();

  const handleSubmit = async () => {
    if (!trimmedName) return;
    let data: TBotMemberCreate | TBotMemberUpdate;
    if (bot) {
      const changes: TBotMemberUpdate = {};
      if (trimmedName !== bot.name) changes.name = trimmedName;
      if (role !== bot.role) changes.role = role;
      if (description.trim() !== bot.description) changes.description = description.trim();
      if (Object.keys(changes).length === 0) {
        onClose();
        return;
      }
      data = changes;
    } else {
      data = { name: trimmedName, role, description: description.trim() };
    }
    setErrors({});
    setIsSubmitting(true);
    try {
      await onSubmit(data);
      setToast({ type: "success", title: t(isEdit ? "bot_members.toasts.updated" : "bot_members.toasts.created") });
    } catch (caught) {
      const fieldErrors = codingFieldErrors(caught);
      setErrors(fieldErrors);
      setToast({
        type: "error",
        title: t(isEdit ? "bot_members.toasts.update_failed" : "bot_members.toasts.create_failed"),
        message: codingErrorMessage(t, caught),
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
              <DialogTitle>
                {bot ? t("bot_members.form.edit_title", { name: bot.name }) : t("bot_members.form.create_title")}
              </DialogTitle>
              {!isEdit && <DialogDescription>{t("bot_members.form.create_description")}</DialogDescription>}
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <form
              id="bot-member-form"
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <InputField
                id="bot-member-name"
                name="name"
                size="lg"
                orientation="vertical"
                label={t("bot_members.form.name")}
                placeholder={t("bot_members.form.name_placeholder")}
                autoComplete="off"
                maxLength={MAX_BOT_NAME_LENGTH}
                value={name}
                disabled={isSubmitting}
                {...(errors.name ? { error: errors.name } : {})}
                onChange={(event) => setName(event.target.value)}
              />
              <SelectField<string>
                label={t("bot_members.form.role")}
                hint={t("bot_members.form.role_hint")}
                size="lg"
                width="auto"
                options={BOT_ROLES.map((value) => ({ value: String(value), label: t(botRoleKey(value) ?? "") }))}
                value={String(role)}
                onValueChange={(value) => {
                  if (value) setRole(Number(value) as TBotMemberRole);
                }}
                disabled={isSubmitting}
                {...(errors.role ? { error: errors.role } : {})}
              />
              <TextAreaField
                id="bot-member-description"
                name="description"
                size="lg"
                resize="none"
                autoResize
                maxRows={6}
                label={t("bot_members.form.description")}
                placeholder={t("bot_members.form.description_placeholder")}
                maxLength={MAX_BOT_DESCRIPTION_LENGTH}
                value={description}
                disabled={isSubmitting}
                {...(errors.description ? { error: errors.description } : {})}
                onChange={(event) => setDescription(event.target.value)}
              />
            </form>
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
            type="submit"
            form="bot-member-form"
            variant="primary"
            size="md"
            stretch="auto"
            loading={isSubmitting}
            disabled={!trimmedName}
            label={t(SUBMIT_LABEL[isEdit ? "edit" : "create"][isSubmitting ? 1 : 0])}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
