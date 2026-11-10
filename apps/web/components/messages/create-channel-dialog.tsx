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
import { SwitchField } from "@makeplane/propel/components/switch-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
// hooks
import { useAppRouter } from "@/hooks/use-app-router";
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { ChannelProjectField } from "./channel-project";
import { chatErrorMessage } from "./helpers";

/** The API's limit on channel names (`Channel.name`). */
const MAX_NAME_LENGTH = 80;
/** The API's limit on channel descriptions. */
const MAX_DESCRIPTION_LENGTH = 2000;

type Props = {
  workspaceSlug: string;
  onClose: () => void;
};

export function CreateChannelDialog({ workspaceSlug, onClose }: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { createChannel } = useChat();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [project, setProject] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("messages.create_channel.name_required"));
      return;
    }
    setError(undefined);
    setIsSubmitting(true);
    try {
      const channel = await createChannel({
        name: trimmed,
        description: description.trim(),
        kind: isPrivate ? "private" : "public",
        ...(project ? { project } : {}),
      });
      onClose();
      router.push(`/${workspaceSlug}/messages/${channel.id}`);
    } catch (caught) {
      const message = chatErrorMessage(caught);
      if (message) setError(message);
      else setToast({ type: "error", title: t("messages.errors.create_channel_failed") });
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
              <DialogTitle>{t("messages.create_channel.title")}</DialogTitle>
              <DialogDescription>{t("messages.create_channel.description")}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <form
              id="chat-create-channel-form"
              noValidate
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <InputField
                id="chat-channel-name"
                name="name"
                size="lg"
                orientation="vertical"
                label={t("messages.create_channel.name")}
                placeholder={t("messages.create_channel.name_placeholder")}
                required
                autoComplete="off"
                maxLength={MAX_NAME_LENGTH}
                value={name}
                {...(error ? { error } : {})}
                onChange={(event) => setName(event.target.value)}
              />
              <InputField
                id="chat-channel-description"
                name="description"
                size="lg"
                orientation="vertical"
                label={t("messages.create_channel.description_label")}
                autoComplete="off"
                maxLength={MAX_DESCRIPTION_LENGTH}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <SwitchField
                name="private"
                size="lg"
                switchSize="md"
                label={t("messages.create_channel.private")}
                description={t("messages.create_channel.private_help")}
                checked={isPrivate}
                onCheckedChange={setIsPrivate}
              />
              <ChannelProjectField
                workspaceSlug={workspaceSlug}
                value={project}
                onChange={setProject}
                disabled={isSubmitting}
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
            variant="primary"
            size="md"
            stretch="auto"
            type="submit"
            form="chat-create-channel-form"
            label={t("messages.create_channel.submit")}
            loading={isSubmitting}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
