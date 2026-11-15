/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo, useState } from "react";
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
import { useCodingMachine } from "@/hooks/store/use-coding-machine";
// local imports
import { codingErrorMessage } from "../coding-jobs/helpers";
import { MACHINE_STATE_VARIANT, useMachineRefresh } from "./helpers";
import { MachineOnlineStatus } from "./machine-details";

type Props = {
  workspaceSlug: string;
};

/**
 * Workspace settings → Machines, for workspace admins: every machine in the workspace with its owner, state and
 * online status. An admin can revoke one; only its owner can remove it.
 */
export const CodingMachinesAdmin = observer(function CodingMachinesAdmin({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const { getAllMachines, fetchAllMachines, revokeMachine } = useCodingMachine();
  const [loadFailed, setLoadFailed] = useState(false);
  const [revoking, setRevoking] = useState<TCodingMachine | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const machines = getAllMachines(workspaceSlug);

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

  const handleRevoke = async () => {
    if (!revoking) return;
    setIsSubmitting(true);
    try {
      await revokeMachine(workspaceSlug, revoking.id);
      setToast({ type: "success", title: t("coding_machines.toasts.revoked") });
      setRevoking(null);
    } catch (caught) {
      setToast({
        type: "error",
        title: t("coding_machines.toasts.revoke_failed"),
        message: codingErrorMessage(t, caught),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns: DataTableColumn<TCodingMachine>[] = [
    {
      key: "owner",
      content: t("coding_machines.admin.owner"),
      tdRender: (machine) => <span className="text-body-xs-regular text-primary">{machine.owner_display_name}</span>,
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
      tdRender: (machine) =>
        machine.state === "revoked" ? null : (
          <div className="flex justify-end px-2">
            <Button
              variant="secondary"
              size="sm"
              stretch="auto"
              label={t("coding_machines.admin.revoke")}
              aria-label={`${t("coding_machines.admin.revoke")}: ${machine.name}`}
              onClick={() => setRevoking(machine)}
            />
          </div>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
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
        handleClose={() => setRevoking(null)}
        handleSubmit={handleRevoke}
      />
    </div>
  );
});
