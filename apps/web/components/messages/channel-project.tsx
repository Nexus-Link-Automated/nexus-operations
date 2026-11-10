/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
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
import { ProjectsOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TChatChannel } from "@plane/types";
// components
import { ProjectSelect } from "@/components/dropdowns/project/project-select";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
// local imports
import { chatErrorMessage } from "./helpers";

type SelectProps = {
  workspaceSlug: string;
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
};

/**
 * The project a channel posts work item state changes from. Offers the projects the user is a member or admin of,
 * which is what the API allows (`can_link_project`); a link the channel already has stays shown and can be cleared.
 */
export const ChannelProjectField = observer(function ChannelProjectField({
  workspaceSlug,
  value,
  onChange,
  disabled,
}: SelectProps) {
  const { t } = useTranslation();
  const { allowPermissions } = useUserPermissions();
  const { getProjectById } = useProject();

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body-sm-medium text-secondary">{t("messages.project.label")}</span>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ProjectSelect
            value={value}
            onChange={onChange}
            variant="select-md"
            placeholder={t("messages.project.none")}
            disabled={disabled}
            filterOption={(projectId) =>
              allowPermissions(
                [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
                EUserPermissionsLevel.PROJECT,
                workspaceSlug,
                projectId
              )
            }
            // A project the user isn't in can still be the channel's: name it without saying which.
            resolveProject={(projectId) =>
              getProjectById(projectId) ? undefined : { id: projectId, name: t("messages.project.hidden") }
            }
          />
        </div>
        {value && (
          <Button
            variant="ghost"
            size="md"
            stretch="auto"
            label={t("messages.project.unlink")}
            disabled={disabled}
            onClick={() => onChange(null)}
          />
        )}
      </div>
      <span className="text-caption-md-regular text-tertiary">{t("messages.project.help")}</span>
    </div>
  );
});

/** The linked project in a channel's header, for a reader who can see the project. */
export const ChannelProjectBadge = observer(function ChannelProjectBadge({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { getProjectById } = useProject();
  const project = getProjectById(projectId);
  if (!project) return null;
  return (
    <span
      className="flex max-w-48 flex-shrink-0 items-center gap-1 rounded-md bg-layer-2 px-1.5 py-0.5 text-caption-md-medium text-secondary"
      title={t("messages.project.linked", { name: project.name })}
    >
      <ProjectsOutline className="size-3.5 flex-shrink-0" aria-hidden />
      <span className="truncate">{project.name}</span>
    </span>
  );
});

type SettingsProps = {
  workspaceSlug: string;
  channel: TChatChannel;
  onClose: () => void;
};

/** A channel's settings, for a channel admin or a workspace admin: for now, its linked project. */
export const ChannelSettingsDialog = observer(function ChannelSettingsDialog({
  workspaceSlug,
  channel,
  onClose,
}: SettingsProps) {
  const { t } = useTranslation();
  const { updateChannel } = useChat();
  const [project, setProject] = useState<string | null>(channel.project);
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (project === channel.project) {
      onClose();
      return;
    }
    setError(undefined);
    setIsSubmitting(true);
    try {
      await updateChannel(channel.id, { project });
      onClose();
    } catch (caught) {
      const message = chatErrorMessage(caught);
      if (message) setError(message);
      else setToast({ type: "error", title: t("messages.errors.update_channel_failed") });
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
              <DialogTitle>{t("messages.channel_settings.title")}</DialogTitle>
              <DialogDescription>
                {t("messages.channel_settings.description", { name: channel.name })}
              </DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <form
              id="chat-channel-settings-form"
              noValidate
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <ChannelProjectField
                workspaceSlug={workspaceSlug}
                value={project}
                onChange={setProject}
                disabled={isSubmitting}
              />
              {error && (
                <p role="alert" className="text-caption-md-regular text-danger-primary">
                  {error}
                </p>
              )}
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
            form="chat-channel-settings-form"
            label={t("messages.channel_settings.save")}
            loading={isSubmitting}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
});
