/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { choosePermission } from "../src/machine/acp-session.ts";
import { makeJobDirs, pruneJobDirs } from "../src/machine/job.ts";
import { parseOrder } from "../src/machine/orders.ts";
import { ProgressCondenser } from "../src/machine/progress.ts";
import { containerArgs, DockerSandboxProvider, imageTag, parsePorcelain } from "../src/machine/sandbox.ts";
import { stageSignIn } from "../src/machine/signins.ts";
import { fakeRunner, memoryLogger } from "./machine-helpers.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nexus-sandbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DIRS = { root: "/data/jobs/j", work: "/data/jobs/j/work", home: "/data/jobs/j/home", out: "/data/jobs/j/out" };

describe("the job container", () => {
  it("runs as the owner without capabilities, with only the job's own folders", () => {
    const args = containerArgs({
      name: "nexus-job-j",
      image: "nexus-machine-job:1.6.0-abc",
      machineId: "m-1",
      jobId: "j",
      dirs: DIRS,
      uid: 1000,
      gid: 1000,
    });
    const joined = args.join(" ");
    expect(joined).toContain("--user 1000:1000");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--label nexus-machine.machine=m-1");
    const mounts = args.flatMap((arg, i) => (args[i - 1] === "--mount" ? [arg] : []));
    expect(mounts).toEqual([
      "type=bind,source=/data/jobs/j/work,target=/job/work",
      "type=bind,source=/data/jobs/j/home,target=/job/home",
      "type=bind,source=/data/jobs/j/out,target=/job/out",
    ]);
    expect(joined).not.toMatch(/docker\.sock|--privileged|--network host|-v /);
  });

  it("passes credentials to the agent by name only, never on the command line", () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const fakeSpawn = ((_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const context = path.join(dir, "job-image");
    mkdirSync(context);
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const provider = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: context,
      env: { PATH: "/usr/bin" },
      log: memoryLogger(),
      run: fakeRunner({}),
      spawn: fakeSpawn,
    });
    return (async () => {
      // The fake runner answers nothing: Docker reads as unavailable and no job can start.
      expect((await provider.prepare(new AbortController().signal)).ready).toBe(false);
      expect(() => provider.create(parsedOrder(), DIRS)).toThrow(/not ready/);

      const ready = new DockerSandboxProvider({
        machineId: "m-1",
        contextDir: context,
        env: { PATH: "/usr/bin" },
        log: memoryLogger(),
        run: fakeRunner({
          "docker version --format {{.Server.Version}}": { stdout: "28.1.1" },
          [`docker image inspect --format {{.Id}} ${imageTag(context)}`]: { stdout: "sha256:x" },
        }),
        spawn: fakeSpawn,
      });
      expect((await ready.prepare(new AbortController().signal)).ready).toBe(true);
      const sandbox = ready.create(parsedOrder(), DIRS);
      sandbox.startAgent("claude", {
        plain: { NEXUS_RESULT_FILE: "/job/out/result.json" },
        secret: { ANTHROPIC_API_KEY: "sk-ant-secret" },
      });
      const [call] = calls;
      expect(call!.args.join(" ")).not.toContain("sk-ant-secret");
      expect(call!.args).toContain("ANTHROPIC_API_KEY");
      expect(call!.args).toContain("NEXUS_RESULT_FILE=/job/out/result.json");
      expect(call!.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(call!.args.slice(-3)).toEqual([`nexus-job-${JOB}`, "node", "/opt/nexus/acp/dist/bin/claude.mjs"]);
    })();
  });

  it("builds the image when it is missing, and tags it by its build context", async () => {
    const context = path.join(dir, "job-image");
    mkdirSync(context);
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const tag = imageTag(context);
    expect(tag).toMatch(/^nexus-machine-job:\d+\.\d+\.\d+-[0-9a-f]{12}$/);
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\nRUN true\n");
    expect(imageTag(context)).not.toBe(tag);
    const run = fakeRunner({
      "docker version --format {{.Server.Version}}": { stdout: "28.1.1" },
      [`docker build --tag ${imageTag(context)} ${context}`]: { stdout: "done" },
    });
    const provider = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: context,
      env: {},
      log: memoryLogger(),
      run,
    });
    expect((await provider.prepare(new AbortController().signal)).ready).toBe(true);
    expect(run.calls.some((call) => call.startsWith("docker build"))).toBe(true);
  });

  it("removes containers a previous run left behind, for this machine only", async () => {
    const run = fakeRunner({
      "docker ps --all --quiet --filter label=nexus-machine.machine=m-1": { stdout: "abc\ndef\n" },
      "docker rm --force abc def": {},
    });
    const provider = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: dir,
      env: {},
      log: memoryLogger(),
      run,
    });
    expect(await provider.removeLeftovers()).toBe(2);
    expect(run.calls).toContain("docker rm --force abc def");
  });

  it("reads changed files from git status", () => {
    expect(parsePorcelain(" M app/auth.py\0?? tests/new.py\0R  new.py\0old.py\0")).toEqual([
      "app/auth.py",
      "tests/new.py",
      "new.py",
    ]);
    expect(parsePorcelain("")).toEqual([]);
  });
});

const JOB = "6f1c0d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";

function parsedOrder() {
  const parsed = parseOrder({
    id: JOB,
    action: "fix_bug",
    agent: "claude",
    repo_url: "https://github.com/example/app",
    branch: "main",
    instructions: "Fix it.",
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.order;
}

describe("job folders", () => {
  it("are private, fresh per attempt, and kept ones are pruned by count and age", () => {
    const root = path.join(dir, "jobs");
    const dirs = makeJobDirs(root, "a");
    writeFileSync(path.join(dirs.work, "left.txt"), "x");
    makeJobDirs(root, "a");
    expect(() => statSync(path.join(dirs.work, "left.txt"))).toThrow();
    expect(statSync(dirs.home).mode & 0o777).toBe(0o700);
    expect(() => makeJobDirs(path.join(dir, "a,b"), "x")).toThrow(/comma/);

    // A job the service was killed in the middle of: its sign-in copy goes, its work stays.
    const killed = makeJobDirs(root, "killed");
    writeFileSync(path.join(killed.home, "auth.json"), "{}");
    pruneJobDirs(root, new Set());
    expect(() => statSync(killed.home)).toThrow();
    expect(statSync(killed.work).isDirectory()).toBe(true);

    makeJobDirs(root, "old");
    pruneJobDirs(root, new Set(["a"]), Date.now() + 8 * 24 * 60 * 60_000);
    expect(() => statSync(path.join(root, "old"))).toThrow();
    expect(statSync(path.join(root, "a")).isDirectory()).toBe(true);
  });
});

describe("sign-ins for a job", () => {
  it("copies the Codex sign-in in and writes a refreshed one back", () => {
    const home = path.join(dir, "home");
    const authFile = path.join(home, ".codex", "auth.json");
    mkdirSync(path.dirname(authFile), { recursive: true });
    const original = JSON.stringify({ tokens: { access_token: "a1", refresh_token: "r1" } });
    writeFileSync(authFile, original);
    const jobHome = path.join(dir, "job-home");
    const staged = stageSignIn("codex", jobHome, { HOME: home });
    expect(staged.env).toEqual({ plain: { PLANE_AGENT_AUTH: "chatgpt", CODEX_HOME: "/job/home/.codex" }, secret: {} });
    const copy = path.join(jobHome, ".codex", "auth.json");
    expect(readFileSync(copy, "utf8")).toBe(original);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    const refreshed = JSON.stringify({ tokens: { access_token: "a2", refresh_token: "r2" } });
    writeFileSync(copy, refreshed);
    staged.finish();
    expect(readFileSync(authFile, "utf8")).toBe(refreshed);
  });

  it("does not overwrite a sign-in that changed meanwhile, nor write back a broken one", () => {
    const home = path.join(dir, "home");
    const authFile = path.join(home, ".codex", "auth.json");
    mkdirSync(path.dirname(authFile), { recursive: true });
    writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "a1" } }));
    const jobHome = path.join(dir, "job-home");
    const staged = stageSignIn("codex", jobHome, { HOME: home });
    writeFileSync(path.join(jobHome, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a2" } }));
    writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "other" } }));
    staged.finish();
    expect(readFileSync(authFile, "utf8")).toContain("other");

    const second = stageSignIn("codex", jobHome, { HOME: home });
    writeFileSync(path.join(jobHome, ".codex", "auth.json"), "{}");
    second.finish();
    expect(readFileSync(authFile, "utf8")).toContain("other");
  });

  it("a saved Codex API key and the Claude key go by name; a missing sign-in is a clear error", () => {
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    expect(stageSignIn("codex", path.join(dir, "jh"), { HOME: home }).env).toEqual({
      plain: { PLANE_AGENT_AUTH: "api_key", CODEX_HOME: "/job/home/.codex-api-key" },
      secret: { OPENAI_API_KEY: "sk-x" },
    });
    expect(stageSignIn("claude", path.join(dir, "jh"), { CLAUDE_CODE_OAUTH_TOKEN: "t" }).env.secret).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "t",
    });
    expect(() => stageSignIn("claude", path.join(dir, "jh"), {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => stageSignIn("codex", path.join(dir, "jh"), { HOME: path.join(dir, "nobody") })).toThrow(/codex login/);
  });
});

describe("progress lines", () => {
  it("joins message chunks, names tools and failures, and shows the plan", () => {
    const lines: string[] = [];
    const progress = new ProgressCondenser((event) => lines.push(`${event.kind}: ${event.text}`));
    progress.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading " } });
    progress.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the code." } });
    progress.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    progress.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "pytest", status: "pending" });
    progress.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
    progress.update({
      sessionUpdate: "plan",
      entries: [
        { content: "Find it", priority: "high", status: "completed" },
        { content: "Fix it", priority: "high", status: "in_progress" },
      ],
    });
    progress.flush();
    expect(lines).toEqual([
      "message: Reading the code.",
      "tool: pytest",
      "tool: Failed: pytest",
      "plan: [x] Find it\n[>] Fix it",
    ]);
  });

  it("answers a permission prompt with an allow option, or cancels when there is none", () => {
    const options = [
      { optionId: "no", name: "Deny", kind: "reject_once" as const },
      { optionId: "yes", name: "Allow", kind: "allow_once" as const },
    ];
    const toolCall = { toolCallId: "t" };
    expect(choosePermission({ sessionId: "s", toolCall, options })).toEqual({
      outcome: { outcome: "selected", optionId: "yes" },
    });
    expect(choosePermission({ sessionId: "s", toolCall, options: options.slice(0, 1) })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});
