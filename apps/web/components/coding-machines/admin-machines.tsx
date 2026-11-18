/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Badge } from "@makeplane/propel/components/badge";
import { Button } from "@makeplane/propel/components/button";
import { ConfirmDialog } from "@plane/blocks/dialog";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TCodingMachine } from "@plane/types";
import { calculateTimeAgo, renderFormattedDate } from "@plane/utils";
// components
import type { DataTableColumn } from "@/components/common/data-table";
import { DataTable } from "@/components/common/data-table";
// hooks
import { useBotMember } from "@/hooks/store/use-bot-member";
import { useCodingMachine } from "@/hooks/store/use-coding-machine";
// local imports
import { BOT_MEMBER_ROLE } from "../bot-members/helpers";
import { codingErrorMessage } from "../coding-jobs/helpers";
import { AddMachineDialog } from "./add-machine-dialog";
import { MACHINE_STATE_VARIANT, useMachineRefresh } from "./helpers";
import { MachineOnlineStatus } from "./machine-details";
import { RenameMachineDialog } from "./rename-machine-dialog";

type Props = {
  workspaceSlug: string;
};

type TDialog = { kind: "revoke" | "approve" | "rename" | "remove"; machine: TCodingMachine };

const TOASTS: Record<"revoke" | "approve" | "remove", { done: string; failed: string }> = {
  revoke: { done: "coding_machines.toasts.revoked", failed: "coding_machines.toasts.revoke_failed" },
  approve: { done: "coding_machines.toasts.approved", failed: "coding_machines.toasts.approve_failed" },
  remove: { done: "coding_machines.toasts.removed", failed: "coding_machines.toasts.remove_failed" },
};

/** A pending machine whose code expired, or a revoked one, can only be removed (and added again). */
const canRename = (machine: TCodingMachine) =>
  machine.state !== "revoked" && !(machine.state === "pending" && machine.join_code_expired);

/**
 * Workspace settings → Machines, for workspace admins: every machine in the workspace with its owner, state and
 * online status. An admin can revoke one; only its owner can remove it. A bot member's machines are the admins' to
 * manage: they add them for an active bot with the Member role (getting the join code once), approve, rename and
 * remove them.
 */
export const CodingMachinesAdmin = observer(function CodingMachinesAdmin({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const {
    getAllMachines,
    fetchAllMachines,
    createMachine,
    renameMachine,
    revokeMachine,
    approveMachine,
    removeMachine,
  } = useCodingMachine();
  const { getBots, fetchBots } = useBotMember();
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialog, setDialog] = useState<TDialog | null>(null);
  const [isAddingForBot, setIsAddingForBot] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const machines = getAllMachines(workspaceSlug);
  const bots = getBots(workspaceSlug);
  // The API takes a machine only for an active bot that is a member (a guest bot cannot run coding jobs).
  const eligibleBots = useMemo(
    () =>
      (bots ?? [])
        .filter((bot) => bot.is_active && bot.role === BOT_MEMBER_ROLE)
        .map((bot) => ({ id: bot.id, name: bot.name })),
    [bots]
  );

  useEffect(() => {
    if (workspaceSlug) fetchBots(workspaceSlug).catch(() => undefined);
  }, [fetchBots, workspaceSlug]);

  const load = useCallback(() => {
    fetchAllMachines(workspaceSlug)
      .then(() => setLoadFailed(false))
      .catch(() => setLoadFailed(true));
  }, [fetchAllMachines, workspaceSlug]);

  useMachineRefresh(load, true);

  const sorted = useMemo(
    () =>
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy; the web app's TS lib (ES2022) has no toSorted
      [...(machines ?? [])].sort(
        (a, b) => a.owner_display_name.localeCompare(b.owner_display_name) || a.created_at.localeCompare(b.created_at)
      ),
    [machines]
  );

  const run = async (kind: "revoke" | "approve" | "remove") => {
    if (!dialog) return;
    setIsSubmitting(true);
    try {
      if (kind === "revoke") await revokeMachine(workspaceSlug, dialog.machine.id);
      else if (kind === "approve") await approveMachine(workspaceSlug, dialog.machine.id);
      else await removeMachine(workspaceSlug, dialog.machine.id);
      setToast({ type: "success", title: t(TOASTS[kind].done) });
      setDialog(null);
    } catch (caught) {
      setToast({ type: "error", title: t(TOASTS[kind].failed), message: codingErrorMessage(t, caught) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const actionButton = (machine: TCodingMachine, kind: TDialog["kind"], label: string) => (
    <Button
      variant={kind === "approve" ? "primary" : "secondary"}
      size="sm"
      stretch="auto"
      label={label}
      aria-label={`${label}: ${machine.name}`}
      onClick={() => setDialog({ kind, machine })}
    />
  );

  const columns: DataTableColumn<TCodingMachine>[] = [
    {
      key: "owner",
      content: t("coding_machines.admin.owner"),
      tdRender: (machine) => (
        <span className="flex items-center gap-1.5">
          <span className="text-body-xs-regular text-primary">{machine.owner_display_name}</span>
          {machine.owner_is_bot && <Badge size="xs" variant="purple" label={t("coding_machines.admin.bot")} />}
        </span>
      ),
    },
    {
      key: "name",
      content: t("coding_machines.admin.name"),
      tdRender: (machine) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body-xs-medium text-primary">{machine.name}</span>
          {machine.hostname && (
            <span className="truncate text-caption-sm-regular text-tertiary">{machine.hostname}</span>
          )}
        </div>
      ),
    },
    {
      key: "state",
      content: t("coding_machines.admin.state"),
      tdRender: (machine) => (
        <Badge
          size="xs"
          variant={MACHINE_STATE_VARIANT[machine.state]}
          label={t(`coding_machines.state.${machine.state}`)}
        />
      ),
    },
    {
      key: "online",
      content: t("coding_machines.admin.status"),
      tdRender: (machine) => <MachineOnlineStatus machine={machine} hideLastSeen />,
    },
    {
      key: "last_seen",
      content: t("coding_machines.admin.last_seen"),
      tdRender: (machine) =>
        machine.last_seen_at ? (
          <time
            className="text-body-xs-regular text-primary"
            dateTime={machine.last_seen_at}
            title={renderFormattedDate(new Date(machine.last_seen_at), "MMM d, yyyy h:mma")}
          >
            {calculateTimeAgo(machine.last_seen_at)}
          </time>
        ) : (
          <span className="text-body-xs-regular text-tertiary">{t("coding_machines.admin.never")}</span>
        ),
    },
    {
      key: "actions",
      content: "",
      tdRender: (machine) => {
        // Only a bot member's machine is the admins' to approve, rename and remove; anyone's can be revoked.
        const bot = machine.owner_is_bot;
        if (!bot && machine.state === "revoked") return null;
        return (
          <div className="flex flex-wrap justify-end gap-2 px-2">
            {bot &&
              machine.state === "awaiting_approval" &&
              actionButton(machine, "approve", t("coding_machines.actions.approve"))}
            {bot && canRename(machine) && actionButton(machine, "rename", t("coding_machines.actions.rename"))}
            {machine.state !== "revoked" && actionButton(machine, "revoke", t("coding_machines.admin.revoke"))}
            {bot && actionButton(machine, "remove", t("coding_machines.actions.remove"))}
          </div>
        );
      },
    },
  ];

  const revoking = dialog?.kind === "revoke" ? dialog.machine : null;
  const approving = dialog?.kind === "approve" ? dialog.machine : null;
  const removing = dialog?.kind === "remove" ? dialog.machine : null;

  return (
    <div className="flex flex-col gap-4">
      {bots && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {eligibleBots.length === 0 && (
            <p className="mr-auto text-body-xs-regular text-tertiary">{t("coding_machines.admin.no_bots")}</p>
          )}
          <Button
            variant="secondary"
            size="md"
            stretch="auto"
            label={t("coding_machines.admin.add_for_bot")}
            disabled={eligibleBots.length === 0}
            onClick={() => setIsAddingForBot(true)}
          />
        </div>
      )}
      {loadFailed && (
        <p role="alert" className="text-body-xs-regular text-danger-primary">
          {t("coding_machines.load_failed")}
        </p>
      )}
      {machines && machines.length === 0 && (
        <p className="rounded-lg border border-subtle bg-surface-1 px-4 py-10 text-center text-body-sm-regular text-tertiary">
          {t("coding_machines.admin.empty")}
        </p>
      )}
      {sorted.length > 0 && (
        <DataTable<TCodingMachine> columns={columns} data={sorted} keyExtractor={(machine) => machine.id} />
      )}
      <ConfirmDialog
        isOpen={!!revoking}
        variant="danger"
        title={t("coding_machines.admin.revoke_dialog.title", { name: revoking?.name ?? "" })}
        content={t("coding_machines.admin.revoke_dialog.description", { owner: revoking?.owner_display_name ?? "" })}
        isSubmitting={isSubmitting}
        primaryButtonText={{
          default: t("coding_machines.admin.revoke_dialog.confirm"),
          loading: t("coding_machines.admin.revoke_dialog.confirming"),
        }}
        secondaryButtonText={t("common.cancel")}
        handleClose={() => setDialog(null)}
        handleSubmit={() => run("revoke")}
      />
      <ConfirmDialog
        isOpen={!!approving}
        variant="primary"
        title={t("coding_machines.approve_dialog.title", { name: approving?.name ?? "" })}
        content={t("coding_machines.admin.approve_bot_description", {
          hostname: approving?.hostname || t("coding_machines.unknown"),
          os: approving?.os || t("coding_machines.unknown"),
          owner: approving?.owner_display_name ?? "",
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
        isOpen={!!removing}
        variant="danger"
        title={t("coding_machines.remove_dialog.title", { name: removing?.name ?? "" })}
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
      {dialog?.kind === "rename" && (
        <RenameMachineDialog
          machine={dialog.machine}
          onRename={(name) => renameMachine(workspaceSlug, dialog.machine.id, name)}
          onClose={() => setDialog(null)}
        />
      )}
      {isAddingForBot && (
        <AddMachineDialog
          bots={eligibleBots}
          onCreate={(name, owner) => createMachine(workspaceSlug, name, owner)}
          onClose={() => setIsAddingForBot(false)}
        />
      )}
    </div>
  );
});
