/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { useTranslation } from "@plane/i18n";
import { CodingJobServiceError } from "@plane/services";
// components
import { ProfileSettingsHeading } from "@/components/settings/profile/heading";
// hooks
import { useCodingMachine } from "@/hooks/store/use-coding-machine";
// local imports
import { AddMachineDialog } from "./add-machine-dialog";
import { useMachineAccess, useMachineRefresh } from "./helpers";
import { CodingMachineItem } from "./machine-item";

type Props = {
  workspaceSlug: string;
  workspaceName: string;
};

/**
 * Profile settings → Machines: the user's own machines in one workspace. They add one (and get its join code once),
 * approve it once it has joined, rename and remove it. The list reloads every 15 s so online status stays current.
 */
export const CodingMachinesSettings = observer(function CodingMachinesSettings({
  workspaceSlug,
  workspaceName,
}: Props) {
  const { t } = useTranslation();
  const { getMachines, fetchMachines, createMachine } = useCodingMachine();
  const access = useMachineAccess(workspaceSlug);
  const [loadError, setLoadError] = useState<"forbidden" | "failed" | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  // Guests cannot have machines; until the role is known, the API's 403 says so.
  const isGuest = (access.known && !access.canHaveMachines) || loadError === "forbidden";
  const machines = getMachines(workspaceSlug);

  const load = useCallback(() => {
    fetchMachines(workspaceSlug)
      .then(() => setLoadError(null))
      .catch((error: unknown) =>
        setLoadError(error instanceof CodingJobServiceError && error.status === 403 ? "forbidden" : "failed")
      );
  }, [fetchMachines, workspaceSlug]);

  useMachineRefresh(load, !(access.known && !access.canHaveMachines) && loadError !== "forbidden");

  return (
    <div className="flex size-full flex-col gap-4">
      <ProfileSettingsHeading
        title={t("coding_machines.title")}
        description={t("coding_machines.description", { workspace: workspaceName })}
        control={
          !isGuest &&
          machines && (
            <Button
              variant="primary"
              size="md"
              stretch="auto"
              label={t("coding_machines.add")}
              onClick={() => setIsAdding(true)}
            />
          )
        }
      />
      {isGuest ? (
        <p className="rounded-lg border border-subtle bg-surface-1 py-10 text-center text-body-sm-regular text-tertiary">
          {t("coding_machines.guest")}
        </p>
      ) : (
        <>
          {loadError === "failed" && (
            <p role="alert" className="text-body-xs-regular text-danger-primary">
              {t("coding_machines.load_failed")}
            </p>
          )}
          {machines && machines.length === 0 && (
            <p className="rounded-lg border border-subtle bg-surface-1 px-4 py-10 text-center text-body-sm-regular text-tertiary">
              {t("coding_machines.empty")}
            </p>
          )}
          {machines && machines.length > 0 && (
            <ul className="flex flex-col gap-3" aria-label={t("coding_machines.title")}>
              {machines.map((machine) => (
                <CodingMachineItem key={machine.id} workspaceSlug={workspaceSlug} machine={machine} />
              ))}
            </ul>
          )}
        </>
      )}
      {isAdding && (
        <AddMachineDialog onCreate={(name) => createMachine(workspaceSlug, name)} onClose={() => setIsAdding(false)} />
      )}
    </div>
  );
});
