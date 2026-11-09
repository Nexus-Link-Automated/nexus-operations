/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { adapterBinPaths } from "../src/bins.ts";
import { loadRunnerConfig } from "../src/config.ts";
import type { AgentRunner } from "../src/server.ts";
import { duDiskScanner } from "../src/workspace.ts";
import {
  USER_ID,
  WORKSPACE_ID,
  acpClient,
  startRunner,
  tempRoot,
  ticket,
  upgradeStatus,
  waitUntil,
} from "./helpers.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "limits-agent.mjs");
const auth = () => ({ Authorization: `Bearer ${ticket()}` });

let runner: AgentRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

describe("configuration", () => {
  const base = { AGENT_RUNNER_SECRET: "s".repeat(40) };

  it("has defaults for every limit", () => {
    expect(loadRunnerConfig(base)).toMatchObject({
      processLimit: 256,
      fileSizeLimitBytes: 4 * 1024 ** 3,
      userDiskLimitBytes: 10 * 1024 ** 3,
      diskCheckIntervalMs: 60_000,
    });
  });

  it("reads overrides, and 0 turns the disk limit off", () => {
    const config = loadRunnerConfig({
      ...base,
      AGENT_RUNNER_NPROC_LIMIT: "64",
      AGENT_RUNNER_FILE_SIZE_LIMIT_BYTES: "2048",
      AGENT_RUNNER_USER_DISK_LIMIT_BYTES: "0",
      AGENT_RUNNER_DISK_CHECK_INTERVAL_MS: "5000",
    });
    expect(config).toMatchObject({
      processLimit: 64,
      fileSizeLimitBytes: 2048,
      userDiskLimitBytes: 0,
      diskCheckIntervalMs: 5000,
    });
  });
});

describe("process and file size limits", () => {
  it("wraps the agent in prlimit in uid isolation", async () => {
    const calls: [string, readonly string[]][] = [];
    const root = tempRoot();
    const started = await startRunner(root, {
      config: { isolation: "uid", processLimit: 100, fileSizeLimitBytes: 1_048_576 },
      chown: async () => undefined,
      spawner: (command, args, options: SpawnOptions) => {
        calls.push([command, args]);
        const { uid: _uid, gid: _gid, ...rest } = options;
        // Only the command line is under test. Really applying --nproc counts everything this user is already
        // running, so on a busy machine the agent couldn't start.
        const [agent, ...agentArgs] = args.slice(args.indexOf("--") + 1);
        return spawn(agent!, agentArgs, rest);
      },
    });
    runner = started.runner;
    const client = acpClient(started.url, auth());
    await client.agent.request("initialize", { protocolVersion: 1 });
    client.close();

    expect(calls).toEqual([
      ["/usr/bin/prlimit", ["--nproc=100", "--fsize=1048576", "--", process.execPath, adapterBinPaths().echo!]],
    ]);
  });

  it("does not wrap the agent without uid isolation", async () => {
    const calls: string[] = [];
    const root = tempRoot();
    const started = await startRunner(root, {
      spawner: (command, args, options) => {
        calls.push(command);
        return spawn(command, args, options);
      },
    });
    runner = started.runner;
    const client = acpClient(started.url, auth());
    await client.agent.request("initialize", { protocolVersion: 1 });
    client.close();
    expect(calls).toEqual([process.execPath]);
  });

  it.runIf(process.getuid?.() === 0)("really applies the limits to the agent's process (root only)", async () => {
    const root = tempRoot();
    // In the agent's HOME: the volume's root is not writable by its uid.
    const reportPath = path.join(root, ".homes", WORKSPACE_ID, USER_ID, "report.json");
    const started = await startRunner(root, {
      config: { isolation: "uid", processLimit: 200, fileSizeLimitBytes: 1_048_576 },
      resolveCommand: () => ({ adapter: "echo", command: process.execPath, args: [FIXTURE] }),
    });
    runner = started.runner;
    const client = acpClient(started.url, {
      Authorization: `Bearer ${ticket({ env: { FIXTURE_REPORT: reportPath, FIXTURE_TRUNCATE_TO: String(2 * 1_048_576) } })}`,
    });
    void client.agent.request("initialize", { protocolVersion: 1 }).catch(() => undefined);

    const report = await waitUntil(() => {
      try {
        return JSON.parse(readFileSync(reportPath, "utf8")) as { limits: string; truncate: string };
      } catch {
        return undefined;
      }
    });
    client.close();
    expect(report.limits).toMatch(/Max processes\s+200\s+200/);
    expect(report.limits).toMatch(/Max file size\s+1048576\s+1048576/);
    expect(report.truncate).toBe("EFBIG");
  });
});

describe("per-user disk limit", () => {
  const dirsOf = (root: string) => [
    path.join(root, WORKSPACE_ID, USER_ID),
    path.join(root, ".homes", WORKSPACE_ID, USER_ID),
    path.join(root, ".tmp", WORKSPACE_ID, USER_ID),
  ];

  it("refuses a new agent when its workspace dir is over the limit, counting cwd, HOME and TMPDIR", async () => {
    const root = tempRoot();
    const scanned: (readonly string[])[] = [];
    const started = await startRunner(root, {
      config: { userDiskLimitBytes: 1024 },
      diskScanner: async (dirs) => {
        scanned.push(dirs);
        return 2048;
      },
    });
    runner = started.runner;

    expect(await upgradeStatus(started.url, auth())).toBe(507);
    expect(runner.agents()).toHaveLength(0);
    expect(scanned).toEqual([dirsOf(root)]);
  });

  it("admits an agent under the limit, and does not scan when the limit is off", async () => {
    const root = tempRoot();
    let scans = 0;
    const started = await startRunner(root, {
      config: { userDiskLimitBytes: 0 },
      diskScanner: async () => {
        scans += 1;
        return 10 ** 12;
      },
    });
    runner = started.runner;
    expect(await upgradeStatus(started.url, auth())).toBe(101);
    expect(scans).toBe(0);
  });

  it("does not block agents when a scan fails", async () => {
    const root = tempRoot();
    const started = await startRunner(root, {
      config: { userDiskLimitBytes: 1024 },
      diskScanner: async () => {
        throw new Error("du is broken");
      },
    });
    runner = started.runner;
    expect(await upgradeStatus(started.url, auth())).toBe(101);
  });

  it("stops running agents when their workspace dir goes over the limit", async () => {
    const root = tempRoot();
    let usedBytes = 100;
    const started = await startRunner(root, {
      config: { userDiskLimitBytes: 1024, diskCheckIntervalMs: 10 },
      diskScanner: async () => usedBytes,
    });
    runner = started.runner;
    const client = acpClient(started.url, auth());
    await client.agent.request("initialize", { protocolVersion: 1 });
    expect(runner.agents()).toHaveLength(1);

    usedBytes = 2048;
    await waitUntil(() => runner!.agents().length === 0);
    client.close();
  });

  it("uses the real scanner: a large file is refused, a large sparse file only counts for its blocks", async () => {
    const root = tempRoot();
    const started = await startRunner(root, { config: { userDiskLimitBytes: 256 * 1024 } });
    runner = started.runner;
    const [cwd] = dirsOf(root);
    mkdirSync(cwd!, { recursive: true });

    // Sparse: 1 GiB apparent, almost no blocks.
    truncateSync(writeBlank(path.join(cwd!, "sparse")), 1024 ** 3);
    expect(await upgradeStatus(started.url, auth())).toBe(101);

    writeFileSync(path.join(cwd!, "real"), Buffer.alloc(512 * 1024, 1));
    expect(await upgradeStatus(started.url, auth())).toBe(507);
  });

  it("duDiskScanner adds up all the directories", async () => {
    const root = tempRoot();
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(path.join(a, "file"), Buffer.alloc(64 * 1024, 1));
    writeFileSync(path.join(b, "file"), Buffer.alloc(64 * 1024, 1));
    const total = await duDiskScanner([a, b]);
    expect(total).toBeGreaterThanOrEqual(128 * 1024);
  });
});

function writeBlank(file: string): string {
  writeFileSync(file, "");
  return file;
}
