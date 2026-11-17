/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type { Logger } from "../logger.ts";
import { runAgentSession } from "./acp-session.ts";
import type { JobEvent } from "./client.ts";
import type { JobAction, JobOrder } from "./orders.ts";
import { ProgressCondenser } from "./progress.ts";
import {
  CONTAINER_REPO,
  CONTAINER_RESULT_FILE,
  SandboxError,
  type JobDirs,
  type JobSandbox,
  type SandboxProvider,
} from "./sandbox.ts";
import { SignInMissing, stageSignIn, type StagedSignIn } from "./signins.ts";
import { homeOf } from "./system.ts";

/**
 * Runs one job from start to result: a fresh folder and container, the clone, the agent with the
 * CRM's instructions, then the result the agent wrote, shaped for the CRM. Whatever goes wrong
 * becomes a `job_error` with a reason a person can act on. The CRM validates the result again
 * and is the only one that changes the work item.
 */

/** What the job came to. `stopped`: the CRM ended it (cancel, timeout on its side); nothing to report. */
export type JobEnd =
  | { readonly kind: "result"; readonly result: Record<string, unknown> }
  | { readonly kind: "stopped" };

/** The CRM's limits (`apps/api/plane/coding/outcomes.py`). */
const SHORT = 2000;
const LONG = 20000;
const MAX_RESULT_BYTES = 512 * 1024;
/** How long the agent gets to stop after `session/cancel` before its container is removed. */
const CANCEL_GRACE_MS = 10_000;
/** Kept job folders (the changes of a job that has no pull request yet): at most this many, this long. */
export const KEEP_JOBS = 20;
export const KEEP_JOB_MS = 7 * 24 * 60 * 60_000;

const ALLOWED: Record<JobAction, readonly string[]> = {
  fix_bug: ["fixed", "could_not_fix", "job_error"],
  write_test: ["test_written", "job_error"],
  write_and_run_test: ["test_passed", "bug_found", "job_error"],
};

/** The fields an agent may report per outcome; `pr_url` and `changed_files` come from the machine, not the agent. */
const FIELDS: Record<string, Record<string, number>> = {
  fixed: { summary: LONG },
  could_not_fix: { attempted: LONG, reason: LONG },
  test_written: { test_name: SHORT, summary: LONG },
  test_passed: { test_name: SHORT, summary: LONG },
  bug_found: { test_name: SHORT, expected: LONG, actual: LONG, output: LONG, reproduce: SHORT },
  job_error: { reason: SHORT },
};

const CODE_OUTCOMES = new Set(["fixed", "test_written", "test_passed", "bug_found"]);

export function jobError(reason: string): Record<string, unknown> {
  return { outcome: "job_error", reason: cut(reason, SHORT) || "The job did not finish." };
}

function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The agent's result as the CRM expects it, or a job error saying what was wrong with it. Unknown
 * fields are dropped and strings cut to the CRM's limits, so a long answer is not refused whole.
 */
export function shapeResult(action: JobAction, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return jobError("The agent's result is not a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const outcome = record.outcome;
  if (typeof outcome !== "string" || !ALLOWED[action].includes(outcome)) {
    return jobError(
      `The agent reported the outcome ${JSON.stringify(String(outcome)).slice(0, 60)}, which a ${action} job cannot have.`
    );
  }
  const shaped: Record<string, unknown> = { outcome };
  for (const [field, max] of Object.entries(FIELDS[outcome] ?? {})) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) shaped[field] = cut(value, max);
  }
  if (outcome === "bug_found" && typeof record.diagnosis === "object" && record.diagnosis !== null) {
    const diagnosis = record.diagnosis as Record<string, unknown>;
    const shapedDiagnosis: Record<string, unknown> = {};
    if (typeof diagnosis.likely_cause === "string") shapedDiagnosis.likely_cause = cut(diagnosis.likely_cause, SHORT);
    if (typeof diagnosis.file === "string" && diagnosis.file) shapedDiagnosis.file = cut(diagnosis.file, 500);
    if (typeof diagnosis.line === "number" && Number.isInteger(diagnosis.line) && diagnosis.line >= 1) {
      shapedDiagnosis.line = diagnosis.line;
    }
    shaped.diagnosis = shapedDiagnosis;
  }
  return shaped;
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), ".local", "share");
  return path.join(base, "nexus-machine");
}

export function jobsDir(env: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), "jobs");
}

/** A fresh, private folder for the job (anything left from an earlier attempt of the same job is removed). */
export function makeJobDirs(root: string, jobId: string): JobDirs {
  // These paths become `--mount` values, where a comma separates options.
  if (/[,\n]/.test(root)) throw new SandboxError(`The jobs folder ${root} cannot contain a comma or a newline.`);
  const dir = path.join(root, jobId);
  rmSync(dir, { recursive: true, force: true });
  const dirs = { root: dir, work: path.join(dir, "work"), home: path.join(dir, "home"), out: path.join(dir, "out") };
  for (const folder of [root, dir, dirs.work, dirs.home, dirs.out]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  return dirs;
}

/**
 * Removes kept job folders past `KEEP_JOBS` or older than `KEEP_JOB_MS`, never one in `running`. Of
 * the others only `work/` ever stays: a job the service could not finish (it was killed) may have
 * left its sign-in copy in `home/`.
 */
export function pruneJobDirs(root: string, running: ReadonlySet<string>, now = Date.now()): void {
  let entries: { name: string; mtime: number }[];
  try {
    entries = readdirSync(root)
      .filter((name) => !running.has(name))
      .map((name) => ({ name, mtime: statSync(path.join(root, name)).mtimeMs }));
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  entries.forEach((entry, index) => {
    const dir = path.join(root, entry.name);
    if (index >= KEEP_JOBS || now - entry.mtime > KEEP_JOB_MS) {
      rmSync(dir, { recursive: true, force: true });
    } else {
      rmSync(path.join(dir, "home"), { recursive: true, force: true });
      rmSync(path.join(dir, "out"), { recursive: true, force: true });
    }
  });
}

function readResult(dirs: JobDirs): unknown {
  const file = path.join(dirs.out, path.basename(CONTAINER_RESULT_FILE));
  let text: string;
  try {
    if (statSync(file).size > MAX_RESULT_BYTES) return { error: "The agent's result file is too large." };
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "The agent's result file is not valid JSON." };
  }
}

export interface JobDeps {
  readonly sandboxes: SandboxProvider;
  readonly jobsRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
  /** Progress lines, in order. */
  readonly emit: (event: JobEvent) => void;
  readonly cancelGraceMs?: number;
}

function duration(seconds: number): string {
  if (seconds < 120) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

const AGENT_NAMES = { codex: "Codex", claude: "Claude" } as const;

/**
 * Runs `order`. `stop` aborts when the CRM ends the job (it then needs no result); the job's own
 * deadline is `order.timeoutSeconds`. Never throws.
 */
export async function runJob(order: JobOrder, deps: JobDeps, stop: AbortSignal): Promise<JobEnd> {
  const { log } = deps;
  const progress = new ProgressCondenser(deps.emit);
  const timeout = AbortSignal.timeout(order.timeoutSeconds * 1000);
  const ended = AbortSignal.any([stop, timeout]);
  let dirs: JobDirs | undefined;
  let sandbox: JobSandbox | undefined;
  let signIn: StagedSignIn | undefined;
  let keep = false;
  const timedOut = () => jobError(`The job ran out of time (${duration(order.timeoutSeconds)}).`);
  try {
    dirs = makeJobDirs(deps.jobsRoot, order.id);
    signIn = stageSignIn(order.agent, dirs.home, deps.env);
    progress.status("Starting the job's container.");
    sandbox = deps.sandboxes.create(order, dirs);
    await sandbox.start();
    progress.status(`Cloning ${order.repoUrl} (${order.branch}).`);
    await sandbox.clone(order.repoUrl, order.branch, ended);
    if (stop.aborted) return { kind: "stopped" };
    if (timeout.aborted) return { kind: "result", result: timedOut() };

    progress.status(`${AGENT_NAMES[order.agent]} is working.`);
    const agent = sandbox.startAgent(order.agent, {
      plain: { ...signIn.env.plain, NEXUS_RESULT_FILE: CONTAINER_RESULT_FILE, PLANE_AGENT_DEFAULT_MODE: "yolo" },
      secret: signIn.env.secret,
    });
    const session = runAgentSession({
      stdin: agent.stdin,
      stdout: agent.stdout,
      cwd: CONTAINER_REPO,
      prompt: order.instructions,
      signal: ended,
      onUpdate: (update) => progress.update(update),
    }).then(
      (answer) => ({ kind: "answer" as const, stopReason: answer.stopReason }),
      (error: unknown) => ({ kind: "failed" as const, error: error instanceof Error ? error.message : String(error) })
    );
    // When the job is stopped, the agent gets `session/cancel` and a grace period, then the container goes.
    const grace = new Promise<"grace">((resolve) => {
      const onEnd = () => setTimeout(() => resolve("grace"), deps.cancelGraceMs ?? CANCEL_GRACE_MS).unref();
      if (ended.aborted) onEnd();
      else ended.addEventListener("abort", onEnd, { once: true });
    });
    const outcome = await Promise.race([session, grace]);
    progress.flush();
    if (stop.aborted) return { kind: "stopped" };
    if (timeout.aborted) return { kind: "result", result: timedOut() };
    if (outcome === "grace") return { kind: "result", result: jobError("The agent did not stop when asked.") };
    if (outcome.kind === "failed") {
      const code = await Promise.race([agent.exited, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      const detail = agent.stderrTail().split("\n").slice(-3).join(" ").trim();
      log.warn("machine-service: the agent failed", { job: order.id, error: outcome.error, code: code ?? null });
      return {
        kind: "result",
        result: jobError(
          `${AGENT_NAMES[order.agent]} stopped unexpectedly (${outcome.error})${detail ? `: ${detail}` : ""}.`
        ),
      };
    }

    const raw = readResult(dirs);
    let result: Record<string, unknown>;
    if (raw === undefined) {
      result = jobError(`${AGENT_NAMES[order.agent]} finished (${outcome.stopReason}) without writing a result.`);
    } else if (typeof raw === "object" && raw !== null && "error" in raw && Object.keys(raw).length === 1) {
      result = jobError(String((raw as { error: unknown }).error));
    } else {
      result = shapeResult(order.action, raw);
    }
    if (CODE_OUTCOMES.has(result.outcome as string)) {
      const files = await sandbox.changedFiles();
      if (files.length) result.changed_files = files;
      // No pull request yet: the changes stay in the job's folder on this machine for a while.
      keep = true;
    }
    progress.status(`Finished: ${String(result.outcome)}.`);
    return { kind: "result", result };
  } catch (error) {
    if (stop.aborted) return { kind: "stopped" };
    if (timeout.aborted) return { kind: "result", result: timedOut() };
    if (error instanceof SandboxError || error instanceof SignInMissing) {
      return { kind: "result", result: jobError(error.message) };
    }
    log.error("machine-service: job failed", { job: order.id, error: (error as Error).message });
    return { kind: "result", result: jobError(`The machine could not run the job (${(error as Error).message}).`) };
  } finally {
    progress.flush();
    await sandbox?.destroy().catch(() => undefined);
    try {
      signIn?.finish();
    } catch (error) {
      log.warn("machine-service: could not save the refreshed Codex sign-in", { error: (error as Error).message });
    }
    if (dirs) {
      // The sign-in copy and the result never stay; the repository stays only for a job with changes.
      rmSync(dirs.home, { recursive: true, force: true });
      rmSync(dirs.out, { recursive: true, force: true });
      if (!keep) rmSync(dirs.root, { recursive: true, force: true });
    }
  }
}
