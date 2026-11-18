/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TCodingAgent } from "./coding-job";

/** A person's own computer that runs their coding jobs (`CodingMachine` in the API). */

export type TCodingMachineState = "pending" | "awaiting_approval" | "active" | "revoked";

export type TCodingMachineAgentReport = {
  id: TCodingAgent;
  installed: boolean;
  signed_in: boolean;
  version?: string | null;
};

/** What the machine last reported about itself. Only shown, never trusted. */
export type TCodingMachineCapabilities = {
  agents: TCodingMachineAgentReport[];
  toolchains: { name: string; version: string }[];
  docker: { available: boolean; version?: string | null };
  slots: { total: number; free: number };
};

export type TCodingMachine = {
  id: string;
  workspace: string;
  owner: string;
  owner_display_name: string;
  /** A bot member's machine: workspace admins add, approve, rename and remove it. */
  owner_is_bot: boolean;
  name: string;
  state: TCodingMachineState;
  /** A heartbeat in the last 45 seconds. */
  is_online: boolean;
  last_seen_at: string | null;
  hostname: string;
  os: string;
  version: string;
  /** Empty (`{}`) until the machine's first report. */
  capabilities: Partial<TCodingMachineCapabilities>;
  join_code_expires_at: string | null;
  join_code_expired: boolean;
  joined_at: string | null;
  approved_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
  updated_at: string;
};

/** The answer to adding a machine: the join code is in it once and never again. */
export type TCodingMachineCreated = TCodingMachine & {
  join_code: string;
  join_code_expires_at: string;
};

/** The codes the machine endpoints refuse with (`{"error", "code"}`). */
export type TCodingMachineErrorCode =
  | "MACHINE_LIMIT"
  | "MACHINE_NOT_JOINED"
  | "MACHINE_REVOKED"
  | "BOT_NOT_ALLOWED"
  | "BOT_NOT_FOUND";
