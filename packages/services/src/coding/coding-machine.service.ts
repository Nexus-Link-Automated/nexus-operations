/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { TCodingMachine, TCodingMachineCreated } from "@plane/types";
import { APIService } from "../api.service";
import { toCodingError } from "./coding-job.service";

/**
 * People's coding machines in one workspace, through the web app's session routes (the same paths as `/api/v1/`).
 * Members and admins manage their own machines; workspace admins also list and revoke everyone's. Guests get 403.
 * Every failure is thrown as a `CodingJobServiceError`.
 */
export class CodingMachineService extends APIService {
  constructor(BASE_URL?: string) {
    super(BASE_URL || API_BASE_URL);
  }

  private machinesPath(workspaceSlug: string) {
    return `/api/workspaces/${workspaceSlug}/coding-machines/`;
  }

  private machinePath(workspaceSlug: string, machineId: string) {
    return `${this.machinesPath(workspaceSlug)}${machineId}/`;
  }

  /** The caller's own machines, oldest first. */
  async list(workspaceSlug: string): Promise<TCodingMachine[]> {
    return this.get(this.machinesPath(workspaceSlug))
      .then((response) => (response?.data as TCodingMachine[]) ?? [])
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Every machine in the workspace. Workspace admins only. */
  async listAll(workspaceSlug: string): Promise<TCodingMachine[]> {
    return this.get(`${this.machinesPath(workspaceSlug)}all/`)
      .then((response) => (response?.data as TCodingMachine[]) ?? [])
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /**
   * Adds a machine. The answer carries its join code, which is never shown again. `owner` (a bot member's user id)
   * adds it for that bot: workspace admins only.
   */
  async create(workspaceSlug: string, data: { name: string; owner?: string }): Promise<TCodingMachineCreated> {
    return this.post(this.machinesPath(workspaceSlug), data)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** The owner only (a workspace admin for a bot member's machine). */
  async rename(workspaceSlug: string, machineId: string, data: { name: string }): Promise<TCodingMachine> {
    return this.patch(this.machinePath(workspaceSlug, machineId), data)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Removes the machine for good; its key stops working at once. The owner only (a workspace admin for a bot member's machine). */
  async remove(workspaceSlug: string, machineId: string): Promise<void> {
    return this.delete(this.machinePath(workspaceSlug, machineId))
      .then(() => undefined)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** `awaiting_approval` → `active`. The owner only (a workspace admin for a bot member's machine). */
  async approve(workspaceSlug: string, machineId: string): Promise<TCodingMachine> {
    return this.post(`${this.machinePath(workspaceSlug, machineId)}approve/`, {})
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Cuts the machine off. Workspace admins only. */
  async revoke(workspaceSlug: string, machineId: string): Promise<TCodingMachine> {
    return this.post(`${this.machinePath(workspaceSlug, machineId)}revoke/`, {})
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }
}
