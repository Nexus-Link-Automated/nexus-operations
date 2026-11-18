/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Mock } from "vitest";
import { vi } from "vitest";
import { EUserPermissions } from "@plane/constants";
import type { TCodingJob, TCodingJobQuestion, TCodingRepositoryAccess, TProjectCodingSettings } from "@plane/types";
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
  pr_branch: "",
  result_received_at: null,
  questions: [],
  error_reason: "",
  retry_of: null,
  comment: null,
  requested_by: "me",
  machine: null,
  ran_on: null,
  ran_on_name: "",
  progress: "",
  progress_at: null,
  deadline_at: null,
  is_active: true,
  is_retryable: false,
  started_at: null,
  finished_at: null,
  created_at: "2026-11-14T10:00:00Z",
  updated_at: "2026-11-14T10:00:00Z",
  ...overrides,
});

export const makeQuestion = (seq: number, overrides: Partial<TCodingJobQuestion> = {}): TCodingJobQuestion => ({
  seq,
  question: `Question ${seq}?`,
  status: "waiting",
  answer: "",
  answered_by: null,
  answered_by_agent: false,
  answered_by_name: null,
  asked_at: "2026-11-14T10:02:00Z",
  answered_at: null,
  ...overrides,
});

export const makeRepository = (overrides: Partial<TCodingRepositoryAccess> = {}): TCodingRepositoryAccess => ({
  repo_url: "https://github.com/acme/app",
  provider: "github",
  app_configured: true,
  install_url: null,
  installed: true,
  private: true,
  repo_default_branch: "main",
  pull_requests: true,
  reason: null,
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

/** The fake service: every method a `vi.fn()` the test can inspect or re-program. */
export type TFakeCodingService = { [K in keyof TCodingJobStoreService]: Mock<TCodingJobStoreService[K]> };

export const fakeCodingService = (overrides: Partial<TCodingJobStoreService> = {}): TFakeCodingService =>
  ({
    list: vi.fn().mockResolvedValue([]),
    start: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    answer: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
    getRepository: vi.fn().mockResolvedValue(makeRepository()),
    updateSettings: vi.fn(),
    listEvents: vi.fn().mockResolvedValue({ results: [], has_more: false }),
    ...overrides,
  }) as TFakeCodingService;

export type TRole = "admin" | "member" | "guest" | "none";

const ROLE_VALUE: Record<TRole, number | undefined> = {
  admin: EUserPermissions.ADMIN,
  member: EUserPermissions.MEMBER,
  guest: EUserPermissions.GUEST,
  none: undefined,
};

/**
 * The permission store fields `useCodingAccess` reads, for a user with `projectRole` in project p1 of workspace
 * "acme" and `workspaceRole` in the workspace. The raw project role, as the API sees it.
 */
export const permissionsFor = (projectRole: TRole, workspaceRole: TRole = "member") => ({
  workspaceProjectsPermissions: { acme: ROLE_VALUE[projectRole] ? { p1: ROLE_VALUE[projectRole] } : {} },
  getWorkspaceRoleByWorkspaceSlug: () => ROLE_VALUE[workspaceRole],
});
