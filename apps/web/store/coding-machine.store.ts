/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, runInAction } from "mobx";
import { CodingMachineService } from "@plane/services";
import type { TCodingMachine, TCodingMachineCreated } from "@plane/types";

/** The REST calls the store makes. `CodingMachineService` in the app; a fake in tests. */
export type TCodingMachineStoreService = Pick<
  CodingMachineService,
  "list" | "listAll" | "create" | "rename" | "remove" | "approve" | "revoke"
>;

/** The machine as stored: the join code is shown once by whoever added it, never kept. */
const withoutJoinCode = (created: TCodingMachineCreated): TCodingMachine => {
  const machine: Partial<TCodingMachineCreated> = { ...created };
  delete machine.join_code;
  return machine as TCodingMachine;
};

/** A new list with `machine` in place of its old copy, or added at the end. */
const upsert = (machines: TCodingMachine[], machine: TCodingMachine) =>
  machines.some((existing) => existing.id === machine.id)
    ? machines.map((existing) => (existing.id === machine.id ? machine : existing))
    : [...machines, machine];

export interface ICodingMachineStore {
  /** Workspace slug → the current user's own machines there, oldest first, once loaded. */
  machinesMap: Record<string, TCodingMachine[]>;
  /** Workspace slug → every machine there (workspace admins only), once loaded. */
  allMachinesMap: Record<string, TCodingMachine[]>;
  getMachines: (workspaceSlug: string | null | undefined) => TCodingMachine[] | undefined;
  getAllMachines: (workspaceSlug: string | null | undefined) => TCodingMachine[] | undefined;
  /** Loads the user's own machines. Members and admins only: a guest's 403 is thrown. */
  fetchMachines: (workspaceSlug: string) => Promise<TCodingMachine[]>;
  /** Loads every machine in the workspace. Workspace admins only. */
  fetchAllMachines: (workspaceSlug: string) => Promise<TCodingMachine[]>;
  /** Adds a machine; the answer carries the join code, which the store does not keep. */
  createMachine: (workspaceSlug: string, name: string) => Promise<TCodingMachineCreated>;
  renameMachine: (workspaceSlug: string, machineId: string, name: string) => Promise<TCodingMachine>;
  removeMachine: (workspaceSlug: string, machineId: string) => Promise<void>;
  approveMachine: (workspaceSlug: string, machineId: string) => Promise<TCodingMachine>;
  revokeMachine: (workspaceSlug: string, machineId: string) => Promise<TCodingMachine>;
}

/**
 * People's coding machines per workspace: the user's own, and (for workspace admins) everyone's. Every action
 * throws the API's refusal as a `CodingJobServiceError` for the caller to show.
 */
export class CodingMachineStore implements ICodingMachineStore {
  machinesMap: Record<string, TCodingMachine[]> = {};
  allMachinesMap: Record<string, TCodingMachine[]> = {};

  private service: TCodingMachineStoreService;
  // Bumped by every change this store makes in a workspace, so a list that was requested before it is dropped
  // rather than bringing back what was just changed. The page's next refresh brings the list up to date.
  private version: Record<string, number> = {};
  // The newest list request per workspace and list: an older one that answers later is dropped.
  private requests: Record<string, number> = {};

  constructor(options: { service?: TCodingMachineStoreService } = {}) {
    makeObservable<CodingMachineStore, "apply">(this, {
      machinesMap: observable,
      allMachinesMap: observable,
      fetchMachines: action,
      fetchAllMachines: action,
      createMachine: action,
      renameMachine: action,
      removeMachine: action,
      approveMachine: action,
      revokeMachine: action,
      apply: action,
    });
    this.service = options.service ?? new CodingMachineService();
  }

  getMachines = (workspaceSlug: string | null | undefined) =>
    workspaceSlug ? this.machinesMap[workspaceSlug] : undefined;

  getAllMachines = (workspaceSlug: string | null | undefined) =>
    workspaceSlug ? this.allMachinesMap[workspaceSlug] : undefined;

  fetchMachines = (workspaceSlug: string) =>
    this.load(workspaceSlug, "own", () => this.service.list(workspaceSlug), this.machinesMap);

  fetchAllMachines = (workspaceSlug: string) =>
    this.load(workspaceSlug, "all", () => this.service.listAll(workspaceSlug), this.allMachinesMap);

  createMachine = async (workspaceSlug: string, name: string) => {
    const created = await this.service.create(workspaceSlug, { name });
    this.apply(workspaceSlug, { machine: withoutJoinCode(created), isOwn: true });
    return created;
  };

  renameMachine = async (workspaceSlug: string, machineId: string, name: string) => {
    const machine = await this.service.rename(workspaceSlug, machineId, { name });
    this.apply(workspaceSlug, { machine, isOwn: true });
    return machine;
  };

  removeMachine = async (workspaceSlug: string, machineId: string) => {
    await this.service.remove(workspaceSlug, machineId);
    this.apply(workspaceSlug, { removedId: machineId });
  };

  approveMachine = async (workspaceSlug: string, machineId: string) => {
    const machine = await this.service.approve(workspaceSlug, machineId);
    this.apply(workspaceSlug, { machine, isOwn: true });
    return machine;
  };

  revokeMachine = async (workspaceSlug: string, machineId: string) => {
    const machine = await this.service.revoke(workspaceSlug, machineId);
    this.apply(workspaceSlug, { machine, isOwn: false });
    return machine;
  };

  private async load(
    workspaceSlug: string,
    list: "own" | "all",
    request: () => Promise<TCodingMachine[]>,
    target: Record<string, TCodingMachine[]>
  ): Promise<TCodingMachine[]> {
    const key = `${list}:${workspaceSlug}`;
    const version = this.version[workspaceSlug] ?? 0;
    const requestId = (this.requests[key] ?? 0) + 1;
    this.requests[key] = requestId;
    const machines = await request();
    const current = target[workspaceSlug];
    if (this.requests[key] !== requestId || ((this.version[workspaceSlug] ?? 0) !== version && current)) {
      return current ?? machines;
    }
    runInAction(() => {
      target[workspaceSlug] = machines;
    });
    return machines;
  }

  /**
   * Puts a changed machine into the lists that hold it, or takes a removed one out. The user's own list takes a
   * machine only when `isOwn` (added, renamed or approved: owner-only actions) or when it already holds it.
   */
  private apply(workspaceSlug: string, change: { machine: TCodingMachine; isOwn: boolean } | { removedId: string }) {
    this.version[workspaceSlug] = (this.version[workspaceSlug] ?? 0) + 1;
    const own = this.machinesMap[workspaceSlug];
    const all = this.allMachinesMap[workspaceSlug];
    if ("removedId" in change) {
      if (own) this.machinesMap[workspaceSlug] = own.filter((existing) => existing.id !== change.removedId);
      if (all) this.allMachinesMap[workspaceSlug] = all.filter((existing) => existing.id !== change.removedId);
      return;
    }
    const { machine, isOwn } = change;
    if (own && (isOwn || own.some((existing) => existing.id === machine.id))) {
      this.machinesMap[workspaceSlug] = upsert(own, machine);
    }
    if (all) this.allMachinesMap[workspaceSlug] = upsert(all, machine);
  }
}
