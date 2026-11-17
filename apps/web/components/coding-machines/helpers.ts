/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";
import { EUserPermissions } from "@plane/constants";
import type { TCodingMachine, TCodingMachineState } from "@plane/types";
// hooks
import { useUserPermissions } from "@/hooks/store/user";

/** How often an open machines page reloads, so online status follows the machines' 15 s heartbeats. */
export const MACHINE_REFRESH_MS = 15_000;

/** What the machine service runs on the machine to trade the join code for its key. */
export const joinCommand = (crmUrl: string, joinCode: string): string => `nexus-machine join ${crmUrl} ${joinCode}`;

/** Starts the machine service, and keeps it starting with the user's session. */
export const START_COMMAND = "systemctl --user enable --now nexus-machine";

export type TMachineBadgeVariant = "neutral" | "info" | "warning" | "grey" | "success" | "danger";

export const MACHINE_STATE_VARIANT: Record<TCodingMachineState, TMachineBadgeVariant> = {
  pending: "neutral",
  awaiting_approval: "warning",
  active: "success",
  revoked: "danger",
};

/**
 * The machines a job can be sent to from the start dialog: the requester's own, approved and online. The list
 * endpoint only returns the caller's machines; the owner check keeps anyone else's out regardless.
 */
export const pickableMachines = (machines: TCodingMachine[] | undefined, userId: string | undefined) =>
  userId ? (machines ?? []).filter((m) => m.owner === userId && m.state === "active" && m.is_online) : [];

export type TMachineAccess = {
  /** The workspace role is loaded. */
  known: boolean;
  /** A workspace member or admin: may have machines (guests get 403). */
  canHaveMachines: boolean;
  /** A workspace admin: sees and may revoke every machine in the workspace. */
  isAdmin: boolean;
};

/** What the machine endpoints allow this user, from their workspace role (as `plane.coding.machines` decides it). */
export const useMachineAccess = (workspaceSlug: string | undefined): TMachineAccess => {
  const { getWorkspaceRoleByWorkspaceSlug } = useUserPermissions();
  const role = workspaceSlug ? Number(getWorkspaceRoleByWorkspaceSlug(workspaceSlug) ?? 0) : 0;
  return {
    known: role > 0,
    canHaveMachines: role >= EUserPermissions.MEMBER,
    isAdmin: role === EUserPermissions.ADMIN,
  };
};

/** Calls `refresh` now and every `MACHINE_REFRESH_MS` while `enabled`, skipping ticks while the tab is hidden. */
export const useMachineRefresh = (refresh: () => void, enabled: boolean): void => {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return undefined;
    latest.current();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) latest.current();
    }, MACHINE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled]);
};
