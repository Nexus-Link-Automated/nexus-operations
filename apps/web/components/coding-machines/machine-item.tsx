/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Badge } from "@makeplane/propel/components/badge";
import { Button } from "@makeplane/propel/components/button";
import { ConfirmDialog } from "@plane/blocks/dialog";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TCodingMachine } from "@plane/types";
import { renderFormattedDate } from "@plane/utils";
// hooks
import { useCodingMachine } from "@/hooks/store/use-coding-machine";
// local imports
import { codingErrorMessage } from "../coding-jobs/helpers";
import { MACHINE_STATE_VARIANT } from "./helpers";
import { MachineOnlineStatus, MachineReport } from "./machine-details";
import { RenameMachineDialog } from "./rename-machine-dialog";

type Props = {
  workspaceSlug: string;
  machine: TCodingMachine;
};

/** One of the user's own machines: its state and report, with Approve, Rename and Remove. */
export const CodingMachineItem = observer(function CodingMachineItem({ workspaceSlug, machine }: Props) {
  const { t } = useTranslation();
  const { approveMachine, renameMachine, removeMachine } = useCodingMachine();
  const [dialog, setDialog] = useState<"approve" | "rename" | "remove" | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const run = async (kind: "approve" | "remove") => {
    setIsSubmitting(true);
    try {
      if (kind === "approve") await approveMachine(workspaceSlug, machine.id);
      else await removeMachine(workspaceSlug, machine.id);
      setToast({
        type: "success",
        title: t(kind === "approve" ? "coding_machines.toasts.approved" : "coding_machines.toasts.removed"),
      });
      setDialog(null);
    } catch (caught) {
      setToast({
        type: "error",
        title: t(kind === "approve" ? "coding_machines.toasts.approve_failed" : "coding_machines.toasts.remove_failed"),
        message: codingErrorMessage(t, caught),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const hint = (() => {
    switch (machine.state) {
      case "pending":
        return machine.join_code_expired
          ? t("coding_machines.pending_expired")
          : t("coding_machines.pending_hint", {
              time: renderFormattedDate(machine.join_code_expires_at, "MMM d, yyyy h:mma") ?? "",
            });
      case "awaiting_approval":
        return t("coding_machines.awaiting_hint", { hostname: machine.hostname || t("coding_machines.unknown") });
      case "revoked":
        return t("coding_machines.revoked_hint");
      default:
        return null;
    }
  })();
  // A pending machine whose code expired, or a revoked one, can only be removed (and added again).
  const canRename = machine.state !== "revoked" && !(machine.state === "pending" && machine.join_code_expired);

  return (
    <li data-testid="coding-machine" className="flex flex-col gap-2 rounded-lg border border-subtle px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body-sm-medium text-primary">{machine.name}</span>
          {machine.state !== "pending" && <MachineOnlineStatus machine={machine} />}
        </div>
        <Badge
          size="sm"
          variant={MACHINE_STATE_VARIANT[machine.state]}
          label={t(`coding_machines.state.${machine.state}`)}
        />
      </div>
      <MachineReport machine={machine} />
      {hint && <p className="text-caption-md-regular text-secondary">{hint}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {machine.state === "awaiting_approval" && (
          <Button
            variant="primary"
            size="sm"
            stretch="auto"
            label={t("coding_machines.actions.approve")}
            onClick={() => setDialog("approve")}
          />
        )}
        {canRename && (
          <Button
            variant="secondary"
            size="sm"
            stretch="auto"
            label={t("coding_machines.actions.rename")}
            onClick={() => setDialog("rename")}
          />
        )}
        <Button
          variant="secondary"
          size="sm"
          stretch="auto"
          label={t("coding_machines.actions.remove")}
          onClick={() => setDialog("remove")}
        />
      </div>

      {dialog === "rename" && (
        <RenameMachineDialog
          machine={machine}
          onRename={(name) => renameMachine(workspaceSlug, machine.id, name)}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        isOpen={dialog === "approve"}
        variant="primary"
        title={t("coding_machines.approve_dialog.title", { name: machine.name })}
        content={t("coding_machines.approve_dialog.description", {
          hostname: machine.hostname || t("coding_machines.unknown"),
          os: machine.os || t("coding_machines.unknown"),
        })}
        isSubmitting={isSubmitting}
        primaryButtonText={{
          default: t("coding_machines.approve_dialog.confirm"),
          loading: t("coding_machines.approve_dialog.confirming"),
        }}
        secondaryButtonText={t("common.cancel")}
        handleClose={() => setDialog(null)}
        handleSubmit={() => run("approve")}
      />
      <ConfirmDialog
        isOpen={dialog === "remove"}
        variant="danger"
        title={t("coding_machines.remove_dialog.title", { name: machine.name })}
        content={t("coding_machines.remove_dialog.description")}
        isSubmitting={isSubmitting}
        primaryButtonText={{
          default: t("coding_machines.remove_dialog.confirm"),
          loading: t("coding_machines.remove_dialog.confirming"),
        }}
        secondaryButtonText={t("common.cancel")}
        handleClose={() => setDialog(null)}
        handleSubmit={() => run("remove")}
      />
    </li>
  );
});
