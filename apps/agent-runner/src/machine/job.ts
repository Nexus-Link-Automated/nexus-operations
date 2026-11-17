/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "../logger.ts";
import { runAgentSession } from "./acp-session.ts";
import { readChanges, type JobChanges } from "./changes.ts";
import type { JobEvent } from "./client.ts";
import type { JobAction, JobOrder } from "./orders.ts";
import { ProgressCondenser } from "./progress.ts";
import type { Ask } from "./questions.ts";
import { readRegularFile, removeAll, withoutNul } from "./files.ts";
import {
  CONTAINER_PATCH_FILE,
  CONTAINER_QUESTION_FILE,
  CONTAINER_REPO,
  CONTAINER_WORK,
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
  | {
      readonly kind: "result";
      readonly result: Record<string, unknown>;
      /** The files the job changed, for the CRM to push and open the pull request with. */
      readonly changes?: JobChanges;
      /** Why a job with changed files sends none (too large, ...); the CRM says it on the work item. */
      readonly changesNote?: string;
    }
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
  const chars = Array.from(withoutNul(value));
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
  if (!removeAll(dir)) throw new SandboxError(`Could not clear the job's folder ${dir}.`);
  const dirs = { root: dir, work: path.join(dir, "work"), home: path.join(dir, "home"), out: path.join(dir, "out") };
  for (const folder of [root, dir, dirs.work, dirs.home, dirs.out]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  return dirs;
}

/**
 * Removes kept job folders past `KEEP_JOBS` or older than `KEEP_JOB_MS`, never one in `running`. Of
 * the others only `changes.patch` ever stays: a job the service could not finish (it was killed)
 * may have left its clone, its sign-in copy in `home/` and its result. Never throws.
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
      removeAll(dir);
    } else {
      for (const part of ["work", "home", "out"]) removeAll(path.join(dir, part));
    }
  });
}

/** The kept changes of a job: `<jobs>/<id>/changes.patch`. */
export const PATCH_FILE = "changes.patch";
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

/** Read only once the container is gone, so nothing can change the file while it is read. */
function readResult(dirs: JobDirs): unknown {
  const file = readRegularFile(path.join(dirs.out, path.basename(CONTAINER_RESULT_FILE)), MAX_RESULT_BYTES);
  if (!file.ok) {
    return file.missing ? undefined : { error: `The agent's result file is ${file.error}.` };
  }
  try {
    return JSON.parse(file.text) as unknown;
  } catch {
    return { error: "The agent's result file is not valid JSON." };
  }
}

/** At most this many questions per job (the CRM's own limit too). */
export const MAX_QUESTIONS = 3;
const MAX_QUESTION_BYTES = 64 * 1024;

/**
 * The job's time limit. It does not run while the job waits for the answer to its agent's question
 * (the CRM moves the job's deadline on by the same time).
 */
export class Deadline {
  readonly #controller = new AbortController();
  #left: number;
  #since = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(ms: number) {
    this.#left = ms;
    this.resume();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  pause(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#left = Math.max(0, this.#left - (Date.now() - this.#since));
  }

  resume(): void {
    if (this.#timer || this.#controller.signal.aborted) return;
    this.#since = Date.now();
    this.#timer = setTimeout(() => this.#controller.abort(new Error("timeout")), this.#left);
    this.#timer.unref();
  }

  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/** The agent's question, if it wrote one (`NEXUS_QUESTION_FILE`); the file is removed once read. */
export function takeQuestion(dirs: JobDirs): string | undefined {
  const file = path.join(dirs.out, path.basename(CONTAINER_QUESTION_FILE));
  const read = readRegularFile(file, MAX_QUESTION_BYTES);
  if (!read.ok && read.missing) return undefined;
  try {
    unlinkSync(file);
  } catch {
    // Already gone, or not a file the service may remove: nothing to ask either way.
  }
  // An agent that wrote its result is done: a question besides it is not asked.
  const result = readRegularFile(path.join(dirs.out, path.basename(CONTAINER_RESULT_FILE)), 1);
  if (!read.ok || result.ok || !result.missing) return undefined;
  try {
    const parsed = JSON.parse(read.text) as unknown;
    const question =
      typeof parsed === "object" && parsed !== null ? (parsed as { question?: unknown }).question : undefined;
    return typeof question === "string" && question.trim() ? cut(question.trim(), 4000) : undefined;
  } catch {
    return undefined;
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
  /** Asks the CRM agent the agent's question and resolves with the next prompt (A2A, `questions.ts`). */
  readonly ask?: Ask;
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
  const deadline = new Deadline(order.timeoutSeconds * 1000);
  const timeout = deadline.signal;
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
    const baseCommit = await sandbox.clone(order.repoUrl, order.branch, ended, order.cloneToken);
    if (stop.aborted) return { kind: "stopped" };
    if (timeout.aborted) return { kind: "result", result: timedOut() };

    progress.status(`${AGENT_NAMES[order.agent]} is working.`);
    const agent = sandbox.startAgent(order.agent, {
      plain: {
        ...signIn.env.plain,
        NEXUS_RESULT_FILE: CONTAINER_RESULT_FILE,
        NEXUS_QUESTION_FILE: CONTAINER_QUESTION_FILE,
        PLANE_AGENT_DEFAULT_MODE: "yolo",
      },
      secret: signIn.env.secret,
    });
    const jobDirs = dirs;
    let asked = 0;
    // After a turn: a question the agent wrote goes to the CRM, and its answer is the next prompt. The clock stops
    // while the job waits.
    const nextPrompt = async (): Promise<string | undefined> => {
      const question = takeQuestion(jobDirs);
      if (!question || !deps.ask || asked >= MAX_QUESTIONS) return undefined;
      asked += 1;
      progress.status(`Asked the CRM: ${cut(question, 200)}`);
      deadline.pause();
      try {
        const answer = await deps.ask(order.id, question, ended);
        if (answer) progress.status("Got an answer; the agent goes on.");
        return answer;
      } finally {
        deadline.resume();
      }
    };
    const session = runAgentSession({
      stdin: agent.stdin,
      stdout: agent.stdout,
      cwd: CONTAINER_REPO,
      prompt: order.instructions,
      signal: ended,
      onUpdate: (update) => progress.update(update),
      nextPrompt,
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

    // Changes are listed inside the container; then it goes, before anything it wrote is read.
    const entries = await sandbox.collectChanges(baseCommit);
    await sandbox.destroy();
    const files = entries.map((entry) => entry.path).slice(0, 200);
    const raw = readResult(dirs);
    let result: Record<string, unknown>;
    if (raw === undefined) {
      result = jobError(`${AGENT_NAMES[order.agent]} finished (${outcome.stopReason}) without writing a result.`);
    } else if (typeof raw === "object" && raw !== null && "error" in raw && Object.keys(raw).length === 1) {
      result = jobError(String((raw as { error: unknown }).error));
    } else {
      result = shapeResult(order.action, raw);
    }
    let changes: JobChanges | undefined;
    let changesNote: string | undefined;
    if (CODE_OUTCOMES.has(result.outcome as string) && files.length) {
      result.changed_files = files;
      // The CRM pushes these and opens the pull request; the files are read now, with the container gone.
      const read = readChanges(
        path.join(dirs.work, path.relative(CONTAINER_WORK, CONTAINER_REPO)),
        baseCommit,
        entries
      );
      if (read.ok) changes = read.changes;
      else changesNote = read.note;
      // The changes also stay on this machine as a patch for a while, in case the pull request cannot be opened.
      // Only the patch: the clone's git config and hooks were written by the agent, and git must never run them on
      // the host.
      const patch = readRegularFile(path.join(dirs.out, path.basename(CONTAINER_PATCH_FILE)), MAX_PATCH_BYTES);
      if (patch.ok) {
        writeFileSync(path.join(dirs.root, PATCH_FILE), patch.text, { mode: 0o600 });
        keep = true;
      }
    }
    progress.status(`Finished: ${String(result.outcome)}.`);
    return {
      kind: "result",
      result,
      ...(changes ? { changes } : {}),
      ...(changesNote ? { changesNote } : {}),
    };
  } catch (error) {
    if (stop.aborted) return { kind: "stopped" };
    if (timeout.aborted) return { kind: "result", result: timedOut() };
    if (error instanceof SandboxError || error instanceof SignInMissing) {
      return { kind: "result", result: jobError(error.message) };
    }
    log.error("machine-service: job failed", { job: order.id, error: (error as Error).message });
    return { kind: "result", result: jobError(`The machine could not run the job (${(error as Error).message}).`) };
  } finally {
    deadline.clear();
    progress.flush();
    await sandbox?.destroy().catch(() => undefined);
    try {
      signIn?.finish();
    } catch (error) {
      log.warn("machine-service: could not save the refreshed Codex sign-in", { error: (error as Error).message });
    }
    if (dirs) {
      // Only a job's patch ever stays. A failed removal (a folder the job made read-only and that even a chmod
      // cannot open) is logged; it never replaces the result.
      const parts = keep ? [dirs.work, dirs.home, dirs.out] : [dirs.root];
      for (const part of parts) {
        if (!removeAll(part)) log.warn("machine-service: could not remove a job folder", { folder: part });
      }
    }
  }
}
