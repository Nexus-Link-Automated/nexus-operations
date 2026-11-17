/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrmClient } from "../src/machine/client.ts";
import { runJob, shapeResult, type JobEnd } from "../src/machine/job.ts";
import { JobManager } from "../src/machine/jobs.ts";
import { parseOrder, type JobOrder } from "../src/machine/orders.ts";
import type { Capabilities } from "../src/machine/report.ts";
import {
  type AgentEnv,
  type AgentProcess,
  type JobDirs,
  type JobSandbox,
  type SandboxProvider,
} from "../src/machine/sandbox.ts";
import { runMachine } from "../src/machine/service.ts";
import { FakeCrm, heartbeatOk, memoryLogger, type RecordedRequest } from "./machine-helpers.ts";

const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-coding-agent.ts");
const KEY = "nxm_test_key";
const JOB_ID = "6f1c0d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
const ORDER = {
  id: JOB_ID,
  action: "fix_bug",
  agent: "claude",
  repo_url: "https://github.com/example/app",
  branch: "main",
  work_item: { id: "w-1", identifier: "APP-7", name: "Login breaks", url: "https://crm.example/x" },
  instructions: "Fix the login bug.",
  timeout_seconds: 600,
};

/**
 * Runs jobs as plain processes in the job's folder instead of Docker containers: the clone is a
 * folder with one file and the agent is `fixtures/fake-coding-agent.ts`. Container paths in the
 * agent's env are mapped to the job's folders, as the container's mounts would.
 */
class ProcessSandboxes implements SandboxProvider {
  ready = true;
  created: { order: JobOrder; dirs: JobDirs; destroyed: boolean; env?: AgentEnv }[] = [];
  agentMode = "fixed";
  cloneError: string | undefined;

  status() {
    return { ready: this.ready };
  }

  async prepare() {
    return this.status();
  }

  async removeLeftovers() {
    return 0;
  }

  create(job: JobOrder, dirs: JobDirs): JobSandbox {
    const record: (typeof this.created)[number] = { order: job, dirs, destroyed: false };
    this.created.push(record);
    const repo = path.join(dirs.work, "repo");
    const children: ReturnType<typeof spawn>[] = [];
    const host = (value: string) =>
      value.replace(/^\/job\/(work|home|out)/, (_m, part: "work" | "home" | "out") => dirs[part]);
    return {
      start: async () => undefined,
      clone: async () => {
        if (this.cloneError) {
          const { SandboxError } = await import("../src/machine/sandbox.ts");
          throw new SandboxError(this.cloneError);
        }
        mkdirSync(repo, { recursive: true });
        writeFileSync(path.join(repo, "README.md"), "app\n");
      },
      startAgent: (_agent, env): AgentProcess => {
        record.env = env;
        const plain = Object.fromEntries(Object.entries(env.plain).map(([k, v]) => [k, host(v)]));
        const child = spawn(process.execPath, [FAKE_AGENT], {
          cwd: repo,
          env: { PATH: process.env.PATH, ...plain, ...env.secret, FAKE_AGENT_MODE: this.agentMode },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
        return { stdin: child.stdin, stdout: child.stdout, exited, stderrTail: () => stderr.slice(-500) };
      },
      changedFiles: async () => readdirSync(repo).filter((name) => name !== "README.md"),
      destroy: async () => {
        record.destroyed = true;
        for (const child of children) child.kill("SIGKILL");
      },
    };
  }
}

let home: string;
let crm: FakeCrm;
let sandboxes: ProcessSandboxes;
const env = () => ({ HOME: home, PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-test" });

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "nexus-jobs-"));
  crm = new FakeCrm();
  await crm.listen();
  sandboxes = new ProcessSandboxes();
});

afterEach(async () => {
  await crm.close();
  rmSync(home, { recursive: true, force: true });
});

function order(extra: Partial<typeof ORDER> = {}): JobOrder {
  const parsed = parseOrder({ ...ORDER, ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.order;
}

function jobsRoot() {
  return path.join(home, "jobs");
}

async function run(job: JobOrder, stop = new AbortController().signal, events: { kind: string; text: string }[] = []) {
  return runJob(
    job,
    {
      sandboxes,
      jobsRoot: jobsRoot(),
      env: env(),
      log: memoryLogger(),
      emit: (e) => events.push(e),
      cancelGraceMs: 2_000,
    },
    stop
  );
}

function resultOf(end: JobEnd): Record<string, unknown> {
  expect(end.kind).toBe("result");
  return (end as Extract<JobEnd, { kind: "result" }>).result;
}

describe("running one job", () => {
  it("runs the agent in yolo mode on the instructions and returns its result with the changed files", async () => {
    const events: { kind: string; text: string }[] = [];
    const end = await run(order(), undefined, events);
    expect(resultOf(end)).toEqual({ outcome: "fixed", summary: "Added a null check.", changed_files: ["fix.txt"] });
    const texts = events.map((e) => `${e.kind}: ${e.text}`);
    expect(texts).toContain("message: Looking at the bug. Found it.");
    expect(texts).toContain("tool: Run the tests");
    expect(texts.at(-1)).toBe("status: Finished: fixed.");
    const [created] = sandboxes.created;
    expect(created!.destroyed).toBe(true);
    // The Claude key goes by name only; the result file is the container's.
    expect(created!.env!.secret).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(created!.env!.plain.NEXUS_RESULT_FILE).toBe("/job/out/result.json");
    // A job with changes keeps its repository for the owner, but never its home (sign-ins) or result.
    expect(existsSync(path.join(created!.dirs.work, "repo", "fix.txt"))).toBe(true);
    expect(existsSync(created!.dirs.home)).toBe(false);
    expect(existsSync(created!.dirs.out)).toBe(false);
  });

  it("drops fields the agent may not set, pr_url included", async () => {
    sandboxes.agentMode = "bug_found";
    const end = await run(order({ action: "write_and_run_test" }));
    expect(resultOf(end)).toEqual({
      outcome: "bug_found",
      test_name: "test_login",
      expected: "200",
      actual: "500",
      output: "AssertionError",
      diagnosis: { likely_cause: "missing null check", file: "app/auth.py", line: 12 },
      reproduce: "pytest tests/test_login.py",
      changed_files: ["fix.txt"],
    });
  });

  it("a job error when there is no result, a broken one, or the agent crashes", async () => {
    sandboxes.agentMode = "no_result";
    expect(resultOf(await run(order())).reason).toMatch(/without writing a result/);
    sandboxes.agentMode = "bad_json";
    expect(resultOf(await run(order())).reason).toBe("The agent's result file is not valid JSON.");
    sandboxes.agentMode = "crash";
    const crashed = resultOf(await run(order()));
    expect(crashed.outcome).toBe("job_error");
    expect(crashed.reason).toMatch(/^Claude stopped unexpectedly/);
    // Nothing kept for a job without changes.
    expect(readdirSync(jobsRoot())).toEqual([]);
  });

  it("a job error when the repository cannot be cloned or the agent is not signed in", async () => {
    sandboxes.cloneError = "Could not clone the repository (not found).";
    expect(resultOf(await run(order())).reason).toBe("Could not clone the repository (not found).");
    sandboxes.cloneError = undefined;
    const end = await runJob(
      order(),
      { sandboxes, jobsRoot: jobsRoot(), env: { HOME: home }, log: memoryLogger(), emit: () => undefined },
      new AbortController().signal
    );
    expect(resultOf(end).reason).toMatch(/^Claude is not signed in on this machine/);
  });

  it("stopped by the CRM: the agent is cancelled, the container removed, and nothing is reported", async () => {
    sandboxes.agentMode = "wait";
    const stop = new AbortController();
    const running = run(order(), stop.signal);
    await waitFor(() => sandboxes.created[0]?.env !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    expect(await running).toEqual({ kind: "stopped" });
    expect(sandboxes.created[0]!.destroyed).toBe(true);
  });

  it("times out at its deadline as a job error", async () => {
    sandboxes.agentMode = "wait";
    const job = { ...order(), timeoutSeconds: 1 };
    const started = Date.now();
    expect(resultOf(await run(job))).toEqual({ outcome: "job_error", reason: "The job ran out of time (1 second)." });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sandboxes.created[0]!.destroyed).toBe(true);
  });
});

describe("shaping results", () => {
  it("refuses an outcome the action cannot have, and cuts long text", () => {
    expect(shapeResult("write_test", { outcome: "fixed", summary: "x" })).toMatchObject({ outcome: "job_error" });
    expect(shapeResult("fix_bug", "nope")).toMatchObject({ outcome: "job_error" });
    const long = shapeResult("fix_bug", { outcome: "fixed", summary: "x".repeat(30_000) });
    expect(Array.from(long.summary as string)).toHaveLength(20_000);
  });

  it("refuses orders it cannot run safely", () => {
    expect(parseOrder({ ...ORDER, branch: "--upload-pack=x" })).toMatchObject({ ok: false, id: JOB_ID });
    expect(parseOrder({ ...ORDER, repo_url: "https://user:pw@github.com/x/y" })).toMatchObject({ ok: false });
    expect(parseOrder({ ...ORDER, repo_url: "file:///etc" })).toMatchObject({ ok: false });
    expect(parseOrder({ ...ORDER, agent: "gemini" })).toMatchObject({ ok: false });
    expect(parseOrder({ ...ORDER, id: "../x" })).toEqual({ ok: false, error: "the job has no valid id" });
    expect(parseOrder({ ...ORDER, timeout_seconds: 1 })).toMatchObject({ ok: true, order: { timeoutSeconds: 60 } });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    // oxlint-disable-next-line no-await-in-loop -- polling
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function manager(extra: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
  const log = memoryLogger();
  return new JobManager({
    key: KEY,
    slots: 1,
    client: new CrmClient(crm.url),
    log,
    run: (job, emit, stop) =>
      runJob(job, { sandboxes, jobsRoot: jobsRoot(), env: env(), log, emit, cancelGraceMs: 2_000 }, stop),
    flushMs: 50,
    resultRetryMs: 50,
    ...extra,
  });
}

const posted = (requests: RecordedRequest[], suffix: string) => requests.filter((r) => r.url.endsWith(suffix));

describe("the job manager", () => {
  it("sends progress and the result once, and keeps the job listed until the result is delivered", async () => {
    crm.respond = (request) =>
      request.url.endsWith("/result/")
        ? { status: 200, body: { status: "finished", outcome: "fixed", changed: true } }
        : { status: 200, body: { ended: [] } };
    const jobs = manager();
    const stop = new AbortController();
    const flushing = jobs.flushLoop(stop.signal);
    jobs.accept([ORDER, ORDER]);
    expect(jobs.runningIds).toEqual([JOB_ID]);
    expect(jobs.free).toBe(0);
    await jobs.idle();
    stop.abort();
    await flushing;
    expect(jobs.runningIds).toEqual([]);
    const results = posted(crm.requests, `/jobs/${JOB_ID}/result/`);
    expect(results).toHaveLength(1);
    expect(results[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(results[0]!.body).toEqual({
      result: { outcome: "fixed", summary: "Added a null check.", changed_files: ["fix.txt"] },
    });
    const lines = posted(crm.requests, "/jobs/events/").flatMap((r) =>
      (r.body as { jobs: { id: string; events: { text: string }[] }[] }).jobs.flatMap((j) => j.events)
    );
    expect(lines.map((e) => e.text)).toContain("Looking at the bug. Found it.");
    // Every progress line went out before the result.
    const lastEvents = crm.requests.findLastIndex((r) => r.url.endsWith("/jobs/events/"));
    expect(lastEvents).toBeLessThan(crm.requests.indexOf(results[0]!));
  });

  it("stops a job the CRM ended (cancel in a heartbeat, or `ended` for its progress) without a result", async () => {
    sandboxes.agentMode = "wait";
    crm.respond = () => ({ status: 200, body: { ended: [] } });
    const jobs = manager();
    jobs.accept([ORDER]);
    await waitFor(() => sandboxes.created[0]?.env !== undefined);
    jobs.cancel([JOB_ID]);
    await jobs.idle();
    expect(sandboxes.created[0]!.destroyed).toBe(true);
    expect(posted(crm.requests, "/result/")).toHaveLength(0);

    sandboxes.created = [];
    crm.respond = () => ({ status: 200, body: { ended: [JOB_ID] } });
    const stop = new AbortController();
    const flushing = jobs.flushLoop(stop.signal);
    jobs.accept([ORDER]);
    await jobs.idle();
    stop.abort();
    await flushing;
    expect(sandboxes.created[0]!.destroyed).toBe(true);
    expect(posted(crm.requests, "/result/")).toHaveLength(0);
  });

  it("keeps running through a lost connection and delivers progress and the result once it is back", async () => {
    let down = true;
    crm.respond = (request) => {
      if (down) return { status: 503 };
      return request.url.endsWith("/result/")
        ? { status: 200, body: { status: "finished", outcome: "fixed", changed: true } }
        : { status: 200, body: { ended: [] } };
    };
    const jobs = manager();
    const stop = new AbortController();
    const flushing = jobs.flushLoop(stop.signal);
    jobs.accept([ORDER]);
    await waitFor(() => posted(crm.requests, "/result/").length >= 2);
    expect(jobs.runningIds).toEqual([JOB_ID]);
    down = false;
    await jobs.idle();
    stop.abort();
    await flushing;
    const ok = crm.requests.filter((r) => r.url.endsWith("/jobs/events/")).length;
    expect(ok).toBeGreaterThan(0);
    expect(jobs.runningIds).toEqual([]);
  });

  it("reports a refused result as a job error, and gives up on a definite refusal", async () => {
    const answers = [
      { status: 400, body: { code: "INVALID_RESULT", errors: { summary: ["required"] } } },
      { status: 200, body: { status: "finished", outcome: "job_error", changed: true } },
    ];
    crm.respond = (request) =>
      request.url.endsWith("/result/") ? (answers.shift() ?? { status: 409 }) : { status: 200, body: { ended: [] } };
    const jobs = manager();
    jobs.accept([ORDER]);
    await jobs.idle();
    const bodies = posted(crm.requests, "/result/").map((r) => (r.body as { result: { outcome: string } }).result);
    expect(bodies.map((b) => b.outcome)).toEqual(["fixed", "job_error"]);
  });

  it("refuses a job it cannot read with a job error, and takes none while the job image is not ready", async () => {
    crm.respond = () => ({ status: 200, body: { status: "finished", outcome: "job_error", changed: true } });
    const jobs = manager({ canRun: () => false });
    jobs.accept([
      { ...ORDER, agent: "gemini" },
      { ...ORDER, id: "7f1c0d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f" },
    ]);
    await jobs.idle();
    expect(sandboxes.created).toHaveLength(0);
    const bodies = posted(crm.requests, "/result/");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.url).toContain(JOB_ID);
    expect((bodies[0]!.body as { result: { reason: string } }).result.reason).toMatch(/could not read the job/);
  });
});

describe("the heartbeat loop with jobs", () => {
  const CAPS: Capabilities = {
    agents: [{ id: "claude", installed: true, signed_in: true, version: null }],
    toolchains: [],
    docker: { available: true, version: "28.1.1" },
    slots: { total: 1, free: 1 },
  };

  it("lists running jobs, takes new ones from the answer, lowers free slots and stops on a signal", async () => {
    sandboxes.agentMode = "wait";
    const controller = new AbortController();
    const heartbeats: Record<string, unknown>[] = [];
    crm.respond = (request) => {
      if (request.url.endsWith("/heartbeat/")) {
        heartbeats.push(request.body as Record<string, unknown>);
        const answer = heartbeatOk("active");
        const first = heartbeats.length === 1;
        return { ...answer, body: { ...(answer.body as object), jobs: first ? [ORDER] : [] } };
      }
      return { status: 200, body: { ended: [], status: "finished", outcome: "job_error", changed: true } };
    };
    const jobs = manager();
    const sleeps: number[] = [];
    const code = await runMachine({
      config: { url: crm.url, machineId: "m-1", key: KEY, workspaceSlug: "acme", name: "Laptop", slots: 1 },
      client: new CrmClient(crm.url),
      about: { hostname: "laptop", os: "linux", version: "1.6.0" },
      detect: async () => CAPS,
      adjust: (caps) => ({ ...caps, slots: { total: 1, free: jobs.free } }),
      log: memoryLogger(),
      signal: controller.signal,
      jobs,
      sleep: async (ms) => {
        sleeps.push(ms);
        await waitFor(() => sandboxes.created[0]?.env !== undefined);
        if (heartbeats.length >= 2) controller.abort();
      },
    });
    expect(code).toBe(0);
    expect(heartbeats[0]).toMatchObject({ running: [], capabilities: { slots: { free: 1 } } });
    expect(heartbeats[1]).toMatchObject({ running: [JOB_ID], capabilities: { slots: { free: 0 } } });
    // Stopping the service stops the job and tells the CRM it did not finish.
    const result = posted(crm.requests, `/jobs/${JOB_ID}/result/`);
    expect(result).toHaveLength(1);
    expect((result[0]!.body as { result: unknown }).result).toEqual({
      outcome: "job_error",
      reason: "The machine service stopped during the job.",
    });
    expect(sandboxes.created[0]!.destroyed).toBe(true);
  });

  it("stops a job the heartbeat answer cancels", async () => {
    sandboxes.agentMode = "wait";
    const controller = new AbortController();
    let beats = 0;
    crm.respond = (request) => {
      if (!request.url.endsWith("/heartbeat/")) return { status: 200, body: { ended: [] } };
      beats += 1;
      const answer = heartbeatOk("active");
      return {
        ...answer,
        body: { ...(answer.body as object), jobs: beats === 1 ? [ORDER] : [], cancel: beats === 2 ? [JOB_ID] : [] },
      };
    };
    const jobs = manager();
    await runMachine({
      config: { url: crm.url, machineId: "m-1", key: KEY, workspaceSlug: "acme", name: "Laptop", slots: 1 },
      client: new CrmClient(crm.url),
      about: { hostname: "laptop", os: "linux", version: "1.6.0" },
      detect: async () => CAPS,
      log: memoryLogger(),
      signal: controller.signal,
      jobs,
      sleep: async () => {
        if (beats === 1) await waitFor(() => sandboxes.created[0]?.env !== undefined);
        if (beats >= 2) {
          await jobs.idle();
          controller.abort();
        }
      },
    });
    expect(sandboxes.created[0]!.destroyed).toBe(true);
    expect(posted(crm.requests, "/result/")).toHaveLength(0);
  });
});
