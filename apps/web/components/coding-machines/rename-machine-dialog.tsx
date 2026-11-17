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
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { InputField } from "@makeplane/propel/components/input-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TCodingMachine } from "@plane/types";
// local imports
import { codingErrorMessage, codingFieldErrors } from "../coding-jobs/helpers";

type Props = {
  machine: TCodingMachine;
  /** Saves the new name; a refusal is thrown. */
  onRename: (name: string) => Promise<unknown>;
  onClose: () => void;
};

export function RenameMachineDialog({ machine, onRename, onClose }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(machine.name);
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const trimmed = name.trim();

  const handleSubmit = async () => {
    if (!trimmed) return;
    if (trimmed === machine.name) {
      onClose();
      return;
    }
    setError(undefined);
    setIsSubmitting(true);
    try {
      await onRename(trimmed);
      setToast({ type: "success", title: t("coding_machines.toasts.renamed") });
      onClose();
    } catch (caught) {
      const message = codingFieldErrors(caught).name ?? codingErrorMessage(t, caught);
      setError(message);
      setToast({ type: "error", title: t("coding_machines.toasts.rename_failed"), message });
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
      <DialogContent size="sm">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("coding_machines.rename_dialog.title")}</DialogTitle>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <form
              id="coding-machine-rename-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <InputField
                id="coding-machine-rename"
                name="name"
                size="lg"
                orientation="vertical"
                label={t("coding_machines.add_dialog.name")}
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
            form="coding-machine-rename-form"
            variant="primary"
            size="md"
            stretch="auto"
            loading={isSubmitting}
            disabled={!trimmed}
            label={t(isSubmitting ? "coding_machines.rename_dialog.saving" : "coding_machines.rename_dialog.save")}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
