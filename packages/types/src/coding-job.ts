/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Coding jobs on work items (`plane.coding` in the API). */

export type TCodingAction = "fix_bug" | "write_test" | "write_and_run_test";

export type TCodingAgent = "codex" | "claude";

export type TCodingJobStatus = "queued" | "running" | "needs_input" | "finished" | "cancelled";

export type TCodingJobOutcome = "fixed" | "could_not_fix" | "test_written" | "test_passed" | "bug_found" | "job_error";

export type TCodingJob = {
  id: string;
  workspace: string;
  project: string;
  work_item: string;
  action: TCodingAction;
  agent: TCodingAgent;
  status: TCodingJobStatus;
  outcome: TCodingJobOutcome | null;
  /** The validated result the outcome was applied from; its fields depend on the outcome. */
  result: Record<string, unknown>;
  pr_url: string;
  error_reason: string;
  retry_of: string | null;
  comment: string | null;
  requested_by: string | null;
  /** The requester's machine the job was sent to; null is Auto. */
  machine: string | null;
  is_active: boolean;
  is_retryable: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The outcome columns a project maps to its states. */
export type TCodingColumn = "ready" | "failed" | "in_review";

/** The state a column resolves to now; `chosen` is false when it was matched by name. */
export type TCodingResolvedColumn = { id: string; name: string; chosen: boolean } | null;

export type TProjectCodingSettings = {
  project: string;
  enabled: boolean;
  repo_url: string;
  default_branch: string;
  /** Enabled and a repository set: jobs can start. */
  configured: boolean;
  ready_state: string | null;
  failed_state: string | null;
  in_review_state: string | null;
  columns: Record<TCodingColumn, TCodingResolvedColumn>;
  updated_at: string | null;
};

export type TProjectCodingSettingsUpdate = Partial<
  Pick<
    TProjectCodingSettings,
    "enabled" | "repo_url" | "default_branch" | "ready_state" | "failed_state" | "in_review_state"
  >
>;

/** The codes the coding endpoints refuse with (`{"error", "code"}`). */
export type TCodingErrorCode =
  | "CODING_NOT_CONFIGURED"
  | "MACHINE_NOT_AVAILABLE"
  | "WORK_ITEM_NOT_ELIGIBLE"
  | "JOB_ACTIVE"
  | "JOB_NOT_ACTIVE"
  | "JOB_NOT_RETRYABLE";
