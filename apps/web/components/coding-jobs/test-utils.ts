/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { vi } from "vitest";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import type { TCodingJob, TProjectCodingSettings } from "@plane/types";
import type { TCodingJobStoreService } from "@/store/coding-job.store";

/** Test data and fakes shared by the coding job component tests. */

export const makeJob = (id: string, overrides: Partial<TCodingJob> = {}): TCodingJob => ({
  id,
  workspace: "ws",
  project: "p1",
  work_item: "w1",
  action: "fix_bug",
  agent: "codex",
  status: "queued",
  outcome: null,
  result: {},
  pr_url: "",
  error_reason: "",
  retry_of: null,
  comment: null,
  requested_by: "me",
  is_active: true,
  is_retryable: false,
  started_at: null,
  finished_at: null,
  created_at: "2026-11-14T10:00:00Z",
  updated_at: "2026-11-14T10:00:00Z",
  ...overrides,
});

export const makeSettings = (overrides: Partial<TProjectCodingSettings> = {}): TProjectCodingSettings => ({
  project: "p1",
  enabled: true,
  repo_url: "https://github.com/acme/app",
  default_branch: "main",
  configured: true,
  ready_state: null,
  failed_state: null,
  in_review_state: null,
  columns: {
    ready: { id: "s-ready", name: "Ready", chosen: false },
    failed: null,
    in_review: { id: "s-review", name: "In review", chosen: false },
  },
  updated_at: null,
  ...overrides,
});

export const fakeCodingService = (overrides: Partial<TCodingJobStoreService> = {}) =>
  ({
    list: vi.fn().mockResolvedValue([]),
    start: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    updateSettings: vi.fn(),
    ...overrides,
  }) satisfies TCodingJobStoreService;

export type TRole = "admin" | "member" | "guest";

const ROLE_VALUE: Record<TRole, EUserPermissions> = {
  admin: EUserPermissions.ADMIN,
  member: EUserPermissions.MEMBER,
  guest: EUserPermissions.GUEST,
};

/** `allowPermissions` for a user with `projectRole` in the project and `workspaceRole` in the workspace. */
export const allowPermissionsFor =
  (projectRole: TRole, workspaceRole: TRole = "member") =>
  (allowed: EUserPermissions[], level: string) =>
    allowed.includes(ROLE_VALUE[level === EUserPermissionsLevel.WORKSPACE ? workspaceRole : projectRole]);
