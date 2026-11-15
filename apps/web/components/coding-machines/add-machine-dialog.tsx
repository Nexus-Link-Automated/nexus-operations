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
  DialogInfo,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { InputField } from "@makeplane/propel/components/input-field";
import { CopyOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { API_BASE_URL } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TCodingMachineCreated } from "@plane/types";
import { copyTextToClipboard, renderFormattedDate } from "@plane/utils";
// local imports
import { codingErrorMessage, codingFieldErrors } from "../coding-jobs/helpers";
import { START_COMMAND, joinCommand } from "./helpers";

type Props = {
  /** Adds the machine; a refusal is thrown. */
  onCreate: (name: string) => Promise<TCodingMachineCreated>;
  onClose: () => void;
};

/** The CRM address the machine service joins: where the API is, which is this web app's origin unless the API is
 * served from another one. */
const crmUrl = () => API_BASE_URL.replace(/\/+$/, "") || (typeof window === "undefined" ? "" : window.location.origin);

function CommandLine({ label, command }: { label: string; command: string }) {
  const { t } = useTranslation();
  const copy = () => {
    void copyTextToClipboard(command).then(() =>
      setToast({ type: "success", title: t("coding_machines.add_dialog.copied") })
    );
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body-xs-medium text-secondary">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-subtle bg-layer-1 py-1.5 pr-1.5 pl-3">
        <code className="font-mono min-w-0 flex-1 text-body-xs-regular break-all text-primary">{command}</code>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<Icon icon={CopyOutline} />}
          aria-label={`${t("coding_machines.add_dialog.copy")}: ${label}`}
          onClick={copy}
        />
      </div>
    </div>
  );
}

/**
 * Adds a machine: asks for its name, then shows the join command with the join code. The code is shown only here,
 * once: closing the dialog drops it.
 */
export function AddMachineDialog({ onCreate, onClose }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [created, setCreated] = useState<TCodingMachineCreated | null>(null);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(undefined);
    setIsSubmitting(true);
    try {
      setCreated(await onCreate(trimmed));
      setToast({ type: "success", title: t("coding_machines.toasts.added") });
    } catch (caught) {
      const message = codingFieldErrors(caught).name ?? codingErrorMessage(t, caught);
      setError(message);
      setToast({ type: "error", title: t("coding_machines.toasts.add_failed"), message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      // The join code is shown only once: an outside click must not throw it away.
      disablePointerDismissal={!!created}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <DialogContent size="md">
        {created ? (
          <>
            <DialogMain>
              <DialogHeader>
                <DialogHeading>
                  <DialogTitle>{t("coding_machines.add_dialog.code_title", { name: created.name })}</DialogTitle>
                  <DialogDescription>{t("coding_machines.add_dialog.code_description")}</DialogDescription>
                </DialogHeading>
              </DialogHeader>
              <DialogBody>
                <div className="flex flex-col gap-4">
                  <CommandLine
                    label={t("coding_machines.add_dialog.step_join")}
                    command={joinCommand(crmUrl(), created.join_code)}
                  />
                  <CommandLine label={t("coding_machines.add_dialog.step_start")} command={START_COMMAND} />
                  <p className="text-body-xs-regular text-tertiary">{t("coding_machines.add_dialog.after")}</p>
                </div>
              </DialogBody>
            </DialogMain>
            <DialogActions>
              <DialogInfo>
                {t("coding_machines.add_dialog.expires", {
                  time: renderFormattedDate(created.join_code_expires_at, "MMM d, yyyy h:mma") ?? "",
                })}
              </DialogInfo>
              <Button
                variant="primary"
                size="md"
                stretch="auto"
                label={t("coding_machines.add_dialog.done")}
                onClick={onClose}
              />
            </DialogActions>
          </>
        ) : (
          <>
            <DialogMain>
              <DialogHeader>
                <DialogHeading>
                  <DialogTitle>{t("coding_machines.add_dialog.title")}</DialogTitle>
                  <DialogDescription>{t("coding_machines.add_dialog.description")}</DialogDescription>
                </DialogHeading>
              </DialogHeader>
              <DialogBody>
                <form
                  id="coding-machine-add-form"
                  className="flex flex-col gap-4"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSubmit();
                  }}
                >
                  <InputField
                    id="coding-machine-name"
                    name="name"
                    size="lg"
                    orientation="vertical"
                    label={t("coding_machines.add_dialog.name")}
                    placeholder={t("coding_machines.add_dialog.name_placeholder")}
                    autoComplete="off"
                    maxLength={80}
                    value={name}
                    disabled={isSubmitting}
                    {...(error ? { error } : {})}
                    onChange={(event) => setName(event.target.value)}
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
                form="coding-machine-add-form"
                variant="primary"
                size="md"
                stretch="auto"
                loading={isSubmitting}
                disabled={!name.trim()}
                label={t(isSubmitting ? "coding_machines.add_dialog.creating" : "coding_machines.add_dialog.create")}
              />
            </DialogActions>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
