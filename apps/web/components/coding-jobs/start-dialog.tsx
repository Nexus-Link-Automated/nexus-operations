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
import { SelectField } from "@makeplane/propel/components/select-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TCodingAction, TCodingAgent } from "@plane/types";
// local imports
import { CODING_AGENTS, codingErrorMessage } from "./helpers";

/** Until machines can be registered, a job can only go to whichever machine is picked for it. */
const MACHINE_AUTO = "auto";

type Props = {
  action: TCodingAction;
  /** Starts the job; a refusal is thrown. */
  onStart: (agent: TCodingAgent) => Promise<unknown>;
  onClose: () => void;
};

/** Picks the agent (and, later, the machine) for one coding job, then starts it. */
export function CodingJobStartDialog({ action, onStart, onClose }: Props) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<TCodingAgent>("codex");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setError(undefined);
    setIsSubmitting(true);
    try {
      await onStart(agent);
      setToast({ type: "success", title: t("coding_jobs.toasts.started") });
      onClose();
    } catch (caught) {
      const message = codingErrorMessage(t, caught);
      setError(message);
      setToast({ type: "error", title: t("coding_jobs.toasts.start_failed"), message });
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
              <DialogTitle>{t(`coding_jobs.actions.${action}`)}</DialogTitle>
              <DialogDescription>{t(`coding_jobs.start_dialog.description.${action}`)}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <form
              id="coding-job-start-form"
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
            >
              <SelectField<TCodingAgent>
                label={t("coding_jobs.start_dialog.agent")}
                size="lg"
                width="auto"
                options={CODING_AGENTS.map((value) => ({ value, label: t(`coding_jobs.agents.${value}`) }))}
                value={agent}
                onValueChange={(value) => {
                  if (value) setAgent(value);
                }}
                disabled={isSubmitting}
              />
              <SelectField<string>
                label={t("coding_jobs.start_dialog.machine")}
                hint={t("coding_jobs.start_dialog.machine_hint")}
                size="lg"
                width="auto"
                options={[{ value: MACHINE_AUTO, label: t("coding_jobs.start_dialog.machine_auto") }]}
                value={MACHINE_AUTO}
                disabled={isSubmitting}
              />
              {error && (
                <p role="alert" className="text-body-xs-regular text-danger-primary">
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
            type="submit"
            form="coding-job-start-form"
            variant="primary"
            size="md"
            stretch="auto"
            loading={isSubmitting}
            label={t(isSubmitting ? "coding_jobs.start_dialog.starting" : "coding_jobs.start_dialog.start")}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
