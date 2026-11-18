/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Mock } from "vitest";
import { vi } from "vitest";
import type { TCodingMachine, TCodingMachineCreated } from "@plane/types";
import type { TCodingMachineStoreService } from "@/store/coding-machine.store";

/** Test data and fakes shared by the coding machine tests. */

export const makeMachine = (id: string, overrides: Partial<TCodingMachine> = {}): TCodingMachine => ({
  id,
  workspace: "ws",
  owner: "me",
  owner_display_name: "Me",
  owner_is_bot: false,
  name: `Machine ${id}`,
  state: "active",
  is_online: true,
  last_seen_at: "2026-11-14T10:00:00Z",
  hostname: `host-${id}`,
  os: "linux",
  version: "0.1.0",
  capabilities: {
    agents: [
      { id: "codex", installed: true, signed_in: true, version: "0.47.0" },
      { id: "claude", installed: true, signed_in: false, version: null },
    ],
    toolchains: [{ name: "node", version: "24.1.0" }],
    docker: { available: true, version: "28.1.1" },
    slots: { total: 2, free: 1 },
  },
  join_code_expires_at: null,
  join_code_expired: false,
  joined_at: "2026-11-14T09:00:00Z",
  approved_at: "2026-11-14T09:05:00Z",
  revoked_at: null,
  revoked_by: null,
  created_at: "2026-11-14T09:00:00Z",
  updated_at: "2026-11-14T10:00:00Z",
  ...overrides,
});

/** A machine just added: pending, never seen, nothing reported, with its join code. */
export const makeCreated = (id: string, name: string): TCodingMachineCreated => ({
  ...makeMachine(id, {
    name,
    state: "pending",
    is_online: false,
    last_seen_at: null,
    hostname: "",
    os: "",
    version: "",
    capabilities: {},
    joined_at: null,
    approved_at: null,
  }),
  join_code: "ABCD-EFGH-JKLM-NPQR",
  join_code_expires_at: "2026-11-14T10:30:00Z",
});

/** The fake service: every method a `vi.fn()` the test can inspect or re-program. */
export type TFakeMachineService = { [K in keyof TCodingMachineStoreService]: Mock<TCodingMachineStoreService[K]> };

export const fakeMachineService = (overrides: Partial<TCodingMachineStoreService> = {}): TFakeMachineService =>
  ({
    list: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn(),
    revoke: vi.fn(),
    ...overrides,
  }) as TFakeMachineService;
