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
  /** The branch the CRM pushed the agent's work to, e.g. `nexus/fix-bug/1a2b3c4d`; "" when there is none. */
  pr_branch: string;
  /** Set while the CRM is opening the pull request (the job is still `running`). */
  result_received_at: string | null;
  /** The questions the agent asked, oldest first (at most 3). Status `needs_input` means one is open. */
  questions: TCodingJobQuestion[];
  error_reason: string;
  retry_of: string | null;
  comment: string | null;
  requested_by: string | null;
  /** The requester's machine the job was sent to; null is Auto. */
  machine: string | null;
  /** The machine that took the job: null while queued, or after that machine was removed. */
  ran_on: string | null;
  /** That machine's name when it took the job ("" while queued); kept after the machine is removed. */
  ran_on_name: string;
  /** The machine's latest progress line (at most 500 characters). Written by a coding agent: plain text only. */
  progress: string;
  progress_at: string | null;
  /** When the machine stops the job. */
  deadline_at: string | null;
  is_active: boolean;
  is_retryable: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * `thinking`: the CRM agent is working out an answer; `waiting`: a person can answer it; `answered`; `unanswered`:
 * no answer came in time.
 */
export type TCodingJobQuestionStatus = "thinking" | "waiting" | "answered" | "unanswered";

/** A question a coding agent asked while running a job. `question` and `answer` are plain text only. */
export type TCodingJobQuestion = {
  seq: number;
  question: string;
  status: TCodingJobQuestionStatus;
  answer: string;
  /** The person who answered; null when the CRM agent answered, or no one did. */
  answered_by: string | null;
  answered_by_agent: boolean;
  answered_by_name: string | null;
  asked_at: string;
  answered_at: string | null;
};

export type TCodingJobEventKind = "status" | "message" | "tool" | "plan";

/** A progress line a machine reported while running a job. `text` is written by a coding agent: plain text only. */
export type TCodingJobEvent = {
  /** 1, 2, 3, ... per job, in the order the API received them. */
  seq: number;
  kind: TCodingJobEventKind;
  text: string;
  created_at: string;
};

/** Up to 200 of a job's events after a `seq`, oldest first. */
export type TCodingJobEventsPage = {
  results: TCodingJobEvent[];
  has_more: boolean;
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

/** Whether the CRM can open pull requests on the project's repository (it asks GitHub). */
export type TCodingRepositoryAccess = {
  repo_url: string;
  provider: "github" | null;
  /** The CRM has a GitHub App set up. */
  app_configured: boolean;
  /** Where to install the GitHub App on the repository, when that would help. */
  install_url: string | null;
  installed: boolean | null;
  private: boolean | null;
  repo_default_branch: string | null;
  /** Pull requests can be opened. */
  pull_requests: boolean;
  /** Why pull requests can't be opened, in plain words; null when they can. */
  reason: string | null;
};

/** The codes the coding endpoints refuse with (`{"error", "code"}`). */
export type TCodingErrorCode =
  | "CODING_NOT_CONFIGURED"
  | "MACHINE_NOT_AVAILABLE"
  | "WORK_ITEM_NOT_ELIGIBLE"
  | "JOB_ACTIVE"
  | "JOB_NOT_ACTIVE"
  | "JOB_NOT_RETRYABLE"
  | "JOB_LIMIT"
  | "NO_OPEN_QUESTION"
  | "ANSWER_EMPTY";
