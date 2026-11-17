/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { AgentId } from "./report.ts";

/**
 * A job as the CRM hands it out in a heartbeat answer (`apps/api/plane/coding/dispatch.py`
 * `_order`). The CRM wrote the instructions, work-item text fenced as data included; the machine
 * runs them as given and never reads the work item itself.
 */

export const JOB_ACTIONS = ["fix_bug", "write_test", "write_and_run_test"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export interface JobOrder {
  readonly id: string;
  readonly action: JobAction;
  readonly agent: AgentId;
  readonly repoUrl: string;
  readonly branch: string;
  readonly workItem: { readonly id: string; readonly identifier: string; readonly name: string };
  readonly instructions: string;
  readonly timeoutSeconds: number;
  /** A read-only token for a private repository, used for the clone only. */
  readonly cloneToken?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The CRM allows only these in branch names (`plane.coding` settings); checked again here because the branch
// becomes a git argument.
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_INSTRUCTIONS = 200_000;
// A GitHub installation token: it reaches git as a header value, so nothing but these characters.
const TOKEN = /^[A-Za-z0-9_.-]{1,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An https URL without credentials, query or fragment: the only repositories a job clones. */
export function isCloneableRepo(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** The order, or why it cannot be run (the machine then reports a job error for its `id`, when it has one). */
export function parseOrder(raw: unknown): { ok: true; order: JobOrder } | { ok: false; id?: string; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "the job is not an object" };
  const id = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id.toLowerCase() : undefined;
  if (!id) return { ok: false, error: "the job has no valid id" };
  const fail = (error: string) => ({ ok: false as const, id, error });
  const action = raw.action;
  if (typeof action !== "string" || !(JOB_ACTIONS as readonly string[]).includes(action)) return fail("unknown action");
  const agent = raw.agent;
  if (agent !== "codex" && agent !== "claude") return fail("unknown agent");
  if (typeof raw.repo_url !== "string" || !isCloneableRepo(raw.repo_url)) {
    return fail("the repository is not an https URL without credentials");
  }
  if (typeof raw.branch !== "string" || !BRANCH.test(raw.branch) || raw.branch.startsWith("-")) {
    return fail("the branch name is not allowed");
  }
  if (typeof raw.instructions !== "string" || !raw.instructions.trim()) return fail("the job has no instructions");
  const item = isRecord(raw.work_item) ? raw.work_item : {};
  const timeout = typeof raw.timeout_seconds === "number" ? Math.trunc(raw.timeout_seconds) : 3600;
  if (raw.clone_token !== undefined && (typeof raw.clone_token !== "string" || !TOKEN.test(raw.clone_token))) {
    return fail("the repository access token is not valid");
  }
  return {
    ok: true,
    order: {
      id,
      action: action as JobAction,
      agent,
      repoUrl: raw.repo_url,
      branch: raw.branch,
      workItem: {
        id: typeof item.id === "string" ? item.id : "",
        identifier: typeof item.identifier === "string" ? item.identifier.slice(0, 64) : "",
        name: typeof item.name === "string" ? item.name.slice(0, 255) : "",
      },
      instructions: raw.instructions.slice(0, MAX_INSTRUCTIONS),
      timeoutSeconds: Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, timeout)),
      ...(typeof raw.clone_token === "string" ? { cloneToken: raw.clone_token } : {}),
    },
  };
}
