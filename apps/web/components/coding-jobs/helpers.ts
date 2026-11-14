/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CodingJobServiceError } from "@plane/services";
import type { TCodingAction, TCodingAgent, TCodingErrorCode, TIssue } from "@plane/types";

export const CODING_ACTIONS: TCodingAction[] = ["fix_bug", "write_test", "write_and_run_test"];

export const CODING_AGENTS: TCodingAgent[] = ["codex", "claude"];

const REFUSAL_CODES = new Set<string>([
  "CODING_NOT_CONFIGURED",
  "WORK_ITEM_NOT_ELIGIBLE",
  "JOB_ACTIVE",
  "JOB_NOT_ACTIVE",
  "JOB_NOT_RETRYABLE",
] satisfies TCodingErrorCode[]);

/**
 * Whether a job may start on this work item, as the API decides it (`Issue.issue_objects`, else 400
 * `WORK_ITEM_NOT_ELIGIBLE`): not a draft, not archived, and not in intake. `state` is the work item's state from the
 * project's state store, which (like the API's `State.objects`) never holds intake triage states, so an item still in
 * intake (pending, snoozed, rejected or marked duplicate) has none. Until the states load, the answer is no.
 */
export const isWorkItemEligibleForCoding = (
  issue: Pick<TIssue, "archived_at" | "is_draft" | "is_intake"> | undefined,
  state: { group: string } | undefined
) => !!issue && !!state && state.group !== "triage" && !issue.archived_at && !issue.is_draft && !issue.is_intake;

/**
 * The text to show for a failed request: a translated message for each refusal the coding API names, else the API's
 * own message (a coding error, or another Plane endpoint's `{"error": ...}`), else a general one.
 */
export const codingErrorMessage = (t: (key: string) => string, error: unknown): string => {
  if (error instanceof CodingJobServiceError) {
    if (error.code && REFUSAL_CODES.has(error.code)) return t(`coding_jobs.errors.${error.code}`);
    if (error.status === 403) return t("coding_jobs.errors.forbidden");
    if (error.message && error.status) return error.message;
    return t("coding_jobs.errors.generic");
  }
  const body = error as { error?: unknown; detail?: unknown } | null | undefined;
  if (typeof body?.error === "string" && body.error) return body.error;
  if (typeof body?.detail === "string" && body.detail) return body.detail;
  return t("coding_jobs.errors.generic");
};

/** The first field error of a 400, keyed by field. */
export const codingFieldErrors = (error: unknown): Record<string, string> => {
  if (!(error instanceof CodingJobServiceError)) return {};
  return Object.fromEntries(
    Object.entries(error.fieldErrors)
      .filter(([, messages]) => Array.isArray(messages) && messages.length > 0)
      .map(([field, messages]) => [field, String(messages[0])])
  );
};
