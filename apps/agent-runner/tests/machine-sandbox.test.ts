/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { choosePermission } from "../src/machine/acp-session.ts";
import { readRegularFile, removeAll } from "../src/machine/files.ts";
import { makeJobDirs, pruneJobDirs } from "../src/machine/job.ts";
import { parseOrder } from "../src/machine/orders.ts";
import { ProgressCondenser } from "../src/machine/progress.ts";
import { isRepoPath, parseNameStatus, readChanges } from "../src/machine/changes.ts";
import { cloneAccess, containerArgs, DockerSandboxProvider, egressNames, imageTag } from "../src/machine/sandbox.ts";
import type { CommandRunner } from "../src/machine/system.ts";
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
        egress: "open",
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
      egress: "open",
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
      "docker ps --all --quiet --filter label=nexus-machine.machine=m-1 --filter label=nexus-machine.job": {
        stdout: "abc\ndef\n",
      },
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

  it("lists changed files from git diff --name-status", () => {
    expect(parseNameStatus("M\0app/auth.py\0A\0tests/new.py\0D\0old.py\0T\0link\0U\0conflict\0")).toEqual([
      { status: "M", path: "app/auth.py" },
      { status: "A", path: "tests/new.py" },
      { status: "D", path: "old.py" },
      { status: "T", path: "link" },
    ]);
    expect(parseNameStatus("")).toEqual([]);
  });

  it("clones a private repository with the token passed by name, for the repository's host only", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const run: CommandRunner = async (_file, args, options) => {
      calls.push({ args, env: options.env });
      if (args.includes("rev-parse")) return { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      if (args[0] === "version") return { code: 0, stdout: "28.1.1", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const context = path.join(dir, "job-image");
    mkdirSync(context);
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const provider = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: context,
      env: {},
      log: memoryLogger(),
      run,
    });
    await provider.prepare(new AbortController().signal);
    const sandbox = provider.create(parsedOrder(), DIRS);
    const base = await sandbox.clone("https://github.com/example/app", "main", new AbortController().signal, "ghs_abc");
    expect(base).toBe("b".repeat(40));
    const clone = calls.find((call) => call.args.includes("clone"))!;
    expect(clone.args.join(" ")).not.toContain("ghs_abc");
    expect(clone.args).toContain("GIT_CONFIG_VALUE_0");
    expect(clone.env!.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(Buffer.from(clone.env!.GIT_CONFIG_VALUE_0!.split(" ").at(-1)!, "base64").toString()).toBe(
      "x-access-token:ghs_abc"
    );
    // The next command (reading the commit) gets no token.
    const head = calls.find((call) => call.args.includes("rev-parse"))!;
    expect(head.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
    // Without a token, nothing extra.
    calls.length = 0;
    await sandbox.clone("https://github.com/example/app", "main", new AbortController().signal);
    expect(calls[0]!.args).not.toContain("GIT_CONFIG_VALUE_0");
    expect(cloneAccess("https://git.example.com/a/b", "t").GIT_CONFIG_KEY_0).toBe(
      "http.https://git.example.com/.extraHeader"
    );
  });
});

describe("the jobs' egress", () => {
  it("puts job containers on the machine's internal network, with the proxy as their way out", async () => {
    const context = path.join(dir, "job-image");
    mkdirSync(context);
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const image = imageTag(context);
    const names = egressNames("m-1");
    const run = fakeRunner({
      "docker version --format {{.Server.Version}}": { stdout: "28.1.1" },
      [`docker image inspect --format {{.Id}} ${image}`]: { stdout: "sha256:x" },
      [`docker network create --internal --label nexus-machine.machine=m-1 ${names.network}`]: {},
      [`docker rm --force ${names.proxy}`]: {},
      [`docker run --detach --name ${names.proxy} --label nexus-machine.machine=m-1 --label nexus-machine.egress=true --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges --read-only --pids-limit 256 --memory 256m ${image} node /opt/nexus/egress-proxy.mjs`]:
        { stdout: "c1" },
      [`docker network connect --alias nexus-egress ${names.network} ${names.proxy}`]: {},
      [`docker network rm ${names.network}`]: {},
    });
    const provider = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: context,
      env: {},
      log: memoryLogger(),
      run,
    });
    expect((await provider.prepare(new AbortController().signal)).ready).toBe(true);
    const args = containerArgs({
      name: "n",
      image,
      machineId: "m-1",
      jobId: "j",
      dirs: DIRS,
      uid: 1000,
      gid: 1000,
      network: names.network,
    }).join(" ");
    expect(args).toContain(`--network ${names.network}`);
    expect(args).toContain("--env HTTPS_PROXY=http://nexus-egress:3128");
    // Gone when the service stops.
    await provider.shutdown();
    expect(run.calls).toContain(`docker rm --force ${names.proxy}`);
    expect(run.calls).toContain(`docker network rm ${names.network}`);
  });

  it("is not ready when the network cannot be made, and refuses a network that is not internal", async () => {
    const context = path.join(dir, "job-image");
    mkdirSync(context);
    writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\n");
    const names = egressNames("m-1");
    const base = {
      "docker version --format {{.Server.Version}}": { stdout: "28.1.1" },
      [`docker image inspect --format {{.Id}} ${imageTag(context)}`]: { stdout: "sha256:x" },
    };
    const failing = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: context,
      env: {},
      log: memoryLogger(),
      run: fakeRunner(base),
    });
    expect((await failing.prepare(new AbortController().signal)).reason).toMatch(/internal Docker network/);
    const open = new DockerSandboxProvider({
      machineId: "m-1",
      contextDir: context,
      env: {},
      log: memoryLogger(),
      run: fakeRunner({
        ...base,
        [`docker network inspect --format {{.Internal}} ${names.network}`]: { stdout: "false" },
      }),
    });
    expect((await open.prepare(new AbortController().signal)).reason).toMatch(/not internal/);
  });
});

describe("the changes sent for a pull request", () => {
  const BASE = "a".repeat(40);

  it("reads each changed file's content and mode, and lists deletions", () => {
    const repo = path.join(dir, "repo");
    mkdirSync(path.join(repo, "app"), { recursive: true });
    writeFileSync(path.join(repo, "app", "auth.py"), "fixed\n");
    writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n");
    chmodSync(path.join(repo, "run.sh"), 0o755);
    writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 255, 1]));
    symlinkSync("app/auth.py", path.join(repo, "link"));
    const read = readChanges(repo, BASE, [
      { status: "M", path: "app/auth.py" },
      { status: "A", path: "run.sh" },
      { status: "A", path: "bin.dat" },
      { status: "T", path: "link" },
      { status: "D", path: "old.txt" },
    ]);
    expect(read).toEqual({
      ok: true,
      changes: {
        base_commit: BASE,
        files: [
          { path: "app/auth.py", mode: "100644", content: Buffer.from("fixed\n").toString("base64") },
          { path: "run.sh", mode: "100755", content: Buffer.from("#!/bin/sh\n").toString("base64") },
          { path: "bin.dat", mode: "100644", content: "AP8B" },
          { path: "link", mode: "120000", content: Buffer.from("app/auth.py").toString("base64") },
          { path: "old.txt", deleted: true },
        ],
      },
    });
  });

  it("never reads through a linked folder, outside the clone, or past the size limit", () => {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    mkdirSync(path.join(dir, "secret"));
    writeFileSync(path.join(dir, "secret", "key"), "private");
    symlinkSync(path.join(dir, "secret"), path.join(repo, "linked"));
    expect(readChanges(repo, BASE, [{ status: "A", path: "linked/key" }])).toEqual({
      ok: false,
      note: "the changed file linked/key is behind a symbolic link",
    });
    for (const bad of ["../secret/key", ".git/config", "/etc/passwd", "a/./b"]) {
      expect(isRepoPath(bad)).toBe(false);
      expect(readChanges(repo, BASE, [{ status: "A", path: bad }]).ok).toBe(false);
    }
    writeFileSync(path.join(repo, "big"), Buffer.alloc(3 * 1024 * 1024 + 1));
    const big = readChanges(repo, BASE, [{ status: "A", path: "big" }]);
    expect(big.ok === false && big.note).toMatch(/larger than 3 MB/);
    expect(readChanges(repo, "HEAD", [{ status: "D", path: "x" }]).ok).toBe(false);
    expect(readChanges(repo, BASE, [])).toEqual({ ok: false, note: "the job changed no files" });
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

describe("reading what a container wrote", () => {
  it("never blocks on a FIFO, never follows a link, and never reads past its limit", () => {
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    expect(readRegularFile(fifo, 1000)).toMatchObject({ ok: false, error: "not a regular file" });
    expect(Date.now() - started).toBeLessThan(1000);
    const link = path.join(dir, "link");
    symlinkSync("/etc/hostname", link);
    expect(readRegularFile(link, 1000)).toMatchObject({ ok: false });
    const big = path.join(dir, "big");
    writeFileSync(big, "x".repeat(2000));
    expect(readRegularFile(big, 1000)).toMatchObject({ ok: false, error: "too large" });
    expect(readRegularFile(path.join(dir, "none"), 1000)).toMatchObject({ ok: false, missing: true });
    writeFileSync(big, "{}");
    expect(readRegularFile(big, 1000)).toEqual({ ok: true, text: "{}" });
  });

  it("removes folders a job made read-only", () => {
    const root = path.join(dir, "ro");
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    writeFileSync(path.join(root, "a", "b", "f"), "x");
    chmodSync(path.join(root, "a", "b"), 0o555);
    chmodSync(path.join(root, "a"), 0o555);
    expect(removeAll(root)).toBe(true);
    expect(() => statSync(root)).toThrow();
  });
});

describe("job folders", () => {
  it("are private, fresh per attempt, and kept ones are pruned by count and age", () => {
    const root = path.join(dir, "jobs");
    const dirs = makeJobDirs(root, "a");
    writeFileSync(path.join(dirs.work, "left.txt"), "x");
    makeJobDirs(root, "a");
    expect(() => statSync(path.join(dirs.work, "left.txt"))).toThrow();
    expect(statSync(dirs.home).mode & 0o777).toBe(0o700);
    expect(() => makeJobDirs(path.join(dir, "a,b"), "x")).toThrow(/comma/);

    // A job the service was killed in the middle of: its clone and sign-in copy go, a patch stays.
    const killed = makeJobDirs(root, "killed");
    writeFileSync(path.join(killed.home, "auth.json"), "{}");
    writeFileSync(path.join(killed.root, "changes.patch"), "+x");
    pruneJobDirs(root, new Set(["a"]));
    expect(() => statSync(killed.home)).toThrow();
    expect(() => statSync(killed.work)).toThrow();
    expect(readFileSync(path.join(killed.root, "changes.patch"), "utf8")).toBe("+x");

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
    const original = JSON.stringify({ tokens: { access_token: "a1", refresh_token: "r1", account_id: "acct-1" } });
    writeFileSync(authFile, original);
    const jobHome = path.join(dir, "job-home");
    const staged = stageSignIn("codex", jobHome, { HOME: home });
    expect(staged.env).toEqual({ plain: { PLANE_AGENT_AUTH: "chatgpt", CODEX_HOME: "/job/home/.codex" }, secret: {} });
    const copy = path.join(jobHome, ".codex", "auth.json");
    expect(readFileSync(copy, "utf8")).toBe(original);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    const refreshed = JSON.stringify({
      tokens: { access_token: "a2", refresh_token: "r2", account_id: "acct-1" },
      last_refresh: "2026-11-17T00:00:00Z",
    });
    writeFileSync(copy, refreshed);
    staged.finish();
    expect(readFileSync(authFile, "utf8")).toBe(refreshed);
  });

  it("never writes back another account, unknown keys or a file the container swapped for a link", () => {
    const home = path.join(dir, "home");
    const authFile = path.join(home, ".codex", "auth.json");
    mkdirSync(path.dirname(authFile), { recursive: true });
    const original = JSON.stringify({ tokens: { access_token: "a1", account_id: "acct-1" } });
    writeFileSync(authFile, original);
    const jobHome = path.join(dir, "job-home");
    const copy = path.join(jobHome, ".codex", "auth.json");
    for (const planted of [
      { tokens: { access_token: "evil", account_id: "acct-2" } },
      { tokens: { access_token: "a2", account_id: "acct-1" }, extra: 1 },
      { tokens: { access_token: "a2", account_id: "acct-1", shell: "x" } },
    ]) {
      const staged = stageSignIn("codex", jobHome, { HOME: home });
      writeFileSync(copy, JSON.stringify(planted));
      staged.finish();
      expect(readFileSync(authFile, "utf8")).toBe(original);
    }
    const staged = stageSignIn("codex", jobHome, { HOME: home });
    const elsewhere = path.join(dir, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ tokens: { access_token: "a3", account_id: "acct-1" } }));
    rmSync(copy);
    symlinkSync(elsewhere, copy);
    staged.finish();
    expect(readFileSync(authFile, "utf8")).toBe(original);
  });

  it("does not overwrite a sign-in that changed meanwhile, nor write back a broken one", () => {
    const home = path.join(dir, "home");
    const authFile = path.join(home, ".codex", "auth.json");
    mkdirSync(path.dirname(authFile), { recursive: true });
    writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "a1", account_id: "acct-1" } }));
    const jobHome = path.join(dir, "job-home");
    const staged = stageSignIn("codex", jobHome, { HOME: home });
    writeFileSync(
      path.join(jobHome, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "a2", account_id: "acct-1" } })
    );
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
