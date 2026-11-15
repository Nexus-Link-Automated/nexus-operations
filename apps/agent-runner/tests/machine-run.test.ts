/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../src/machine/cli.ts";
import { CrmClient } from "../src/machine/client.ts";
import { configPath, saveMachineConfig, type MachineConfig } from "../src/machine/config.ts";
import type { Capabilities } from "../src/machine/report.ts";
import {
  backoffDelay,
  defaultSleep,
  DEFAULT_BACKOFF,
  EXIT_CONFIG,
  EXIT_OK,
  jitter,
  runMachine,
  type RunOptions,
} from "../src/machine/service.ts";
import { expectStrictHeartbeat, FakeCrm, fakeFs, fakeRunner, heartbeatOk, memoryLogger } from "./machine-helpers.ts";

const KEY = "nxm_test_key";
const ABOUT = { hostname: "laptop", os: "linux x64 Test OS", version: "1.5.0" };
const CAPABILITIES: Capabilities = {
  agents: [
    { id: "codex", installed: true, signed_in: false, version: "0.47.0" },
    { id: "claude", installed: false, signed_in: false, version: null },
  ],
  toolchains: [{ name: "git", version: "2.43.0" }],
  docker: { available: false, version: null },
  slots: { total: 1, free: 1 },
};

let crm: FakeCrm;

beforeEach(async () => {
  crm = new FakeCrm();
  await crm.listen();
});

afterEach(async () => {
  await crm.close();
});

function machineConfig(url = crm.url): MachineConfig {
  return { url, machineId: "m-1", key: KEY, workspaceSlug: "acme", name: "Laptop", slots: 1 };
}

/**
 * Runs the loop against the fake CRM with a fake clock: every sleep is recorded and returns at
 * once, moving the clock on. `onSleep` sees the sleeps so far and may stop the loop or change the CRM.
 */
async function runLoop(
  onSleep: (delays: number[], stop: () => void) => void | Promise<void>,
  extra: Partial<RunOptions> = {}
) {
  const controller = new AbortController();
  const delays: number[] = [];
  const log = memoryLogger();
  let clock = 0;
  let detections = 0;
  const code = await runMachine({
    config: machineConfig(),
    client: new CrmClient(crm.url),
    about: ABOUT,
    detect: async () => {
      detections++;
      return CAPABILITIES;
    },
    log,
    signal: controller.signal,
    random: () => 1,
    now: () => clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
      await onSleep(delays, () => controller.abort());
    },
    ...extra,
  });
  return { code, delays, log, detections: () => detections };
}

describe("machine service: heartbeats", () => {
  it("sends the key and the strict report every heartbeat_seconds, re-detecting only every few minutes", async () => {
    let answered = 0;
    crm.respond = () => heartbeatOk(++answered <= 3 ? "awaiting_approval" : "active");
    const { code, delays, log, detections } = await runLoop(
      (sleeps, stop) => {
        if (sleeps.length === 6) stop();
      },
      { redetectMs: 60_000 }
    );
    expect(code).toBe(EXIT_OK);
    expect(crm.requests).toHaveLength(6);
    for (const request of crm.requests) {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/coding-machines/heartbeat/");
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      expectStrictHeartbeat(request.body);
      expect(request.body).toEqual({ ...ABOUT, capabilities: CAPABILITIES });
    }
    expect(delays).toEqual([15_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
    // At 0 s and again at 60 s.
    expect(detections()).toBe(2);
    const text = log.lines.join("\n");
    expect(text.match(/waiting for the owner to approve/g)).toHaveLength(1);
    expect(text.match(/approved and online/g)).toHaveLength(1);
    expect(text).not.toContain(KEY);
  });

  it("keeps the CRM's heartbeat_seconds within sane bounds", async () => {
    const answers = [heartbeatOk("active", 1), heartbeatOk("active", 100_000), heartbeatOk("active", 30)];
    crm.respond = () => answers.shift() ?? heartbeatOk();
    const { delays } = await runLoop((sleeps, stop) => {
      if (sleeps.length === 3) stop();
    });
    expect(delays).toEqual([5_000, 300_000, 30_000]);
  });
});

describe("machine service: reconnecting", () => {
  it("backs off while the CRM is unreachable, then carries on when it is back", async () => {
    const port = crm.port;
    await crm.close();
    crm.respond = () => heartbeatOk();
    const { code, delays, log } = await runLoop(async (sleeps, stop) => {
      if (sleeps.length === 3) await crm.listen(port);
      if (sleeps.length === 5) stop();
    });
    expect(code).toBe(EXIT_OK);
    expect(delays).toEqual([1_000, 2_000, 4_000, 15_000, 15_000]);
    expect(crm.requests).toHaveLength(2);
    const text = log.lines.join("\n");
    expect(text.match(/warn machine-service: cannot reach the CRM/g)).toHaveLength(1);
    expect(text).toMatch(/connected again/);
  });

  it("retries 5xx and 429 with backoff, honouring Retry-After up to the cap, and resets on success", async () => {
    const answers = [
      { status: 503 },
      { status: 500, body: { error: "boom" } },
      { status: 429, body: { detail: "slow down" }, headers: { "retry-after": "30" } },
      { status: 429, headers: { "retry-after": "3600" } },
      heartbeatOk(),
      { status: 502 },
    ];
    crm.respond = () => answers.shift() ?? heartbeatOk();
    const { code, delays } = await runLoop((sleeps, stop) => {
      if (sleeps.length === 7) stop();
    });
    expect(code).toBe(EXIT_OK);
    expect(delays).toEqual([1_000, 2_000, 30_000, 60_000, 15_000, 1_000, 15_000]);
  });

  it("stops with exit code 78 when the CRM refuses the key for good", async () => {
    crm.respond = () => ({ status: 401, body: { error: "This machine was revoked.", code: "MACHINE_REVOKED" } });
    const { code, delays, log } = await runLoop(() => undefined);
    expect(code).toBe(EXIT_CONFIG);
    expect(delays).toEqual([]);
    expect(crm.requests).toHaveLength(1);
    expect(log.lines.join("\n")).toMatch(/error .*refused this machine's key for good.*MACHINE_REVOKED/);
  });

  it("keeps retrying at the slowest pace while the owner is not allowed (403)", async () => {
    let refusals = 3;
    crm.respond = () =>
      refusals-- > 0
        ? { status: 403, body: { error: "not allowed", code: "MACHINE_OWNER_NOT_ALLOWED" } }
        : heartbeatOk();
    const { code, delays, log } = await runLoop((sleeps, stop) => {
      if (sleeps.length === 4) stop();
    });
    expect(code).toBe(EXIT_OK);
    expect(delays).toEqual([60_000, 60_000, 60_000, 15_000]);
    expect(log.lines.join("\n").match(/warn .*MACHINE_OWNER_NOT_ALLOWED/g)).toHaveLength(1);
  });

  it("drops a report the CRM refuses (400) until the next detection", async () => {
    const answers = [{ status: 400, body: { error: "The request is not valid.", errors: { capabilities: ["x"] } } }];
    crm.respond = () => answers.shift() ?? heartbeatOk();
    await runLoop(
      (sleeps, stop) => {
        if (sleeps.length === 4) stop();
      },
      { redetectMs: 15_000 }
    );
    const bodies = crm.requests.map((request) => Object.keys(request.body as object).includes("capabilities"));
    // Refused; then sent without it; then re-detected (15 s later) and sent again.
    expect(bodies).toEqual([true, false, true, true]);
  });

  it("stops cleanly when signalled while waiting", async () => {
    const controller = new AbortController();
    crm.respond = () => {
      setImmediate(() => controller.abort());
      return heartbeatOk();
    };
    const started = Date.now();
    const code = await runMachine({
      config: machineConfig(),
      client: new CrmClient(crm.url),
      about: ABOUT,
      detect: async () => CAPABILITIES,
      log: memoryLogger(),
      signal: controller.signal,
    });
    expect(code).toBe(EXIT_OK);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("backs off with jitter between half and all of the delay, capped", () => {
    expect(jitter(1_000, () => 0)).toBe(500);
    expect(jitter(1_000, () => 1)).toBe(1_000);
    expect(backoffDelay(1, DEFAULT_BACKOFF)).toBe(1_000);
    expect(backoffDelay(4, DEFAULT_BACKOFF)).toBe(8_000);
    expect(backoffDelay(30, DEFAULT_BACKOFF)).toBe(60_000);
  });

  it("defaultSleep ends early on abort", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    await defaultSleep(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("nexus-machine run", () => {
  it("loads the saved config, heartbeats, and exits 78 on a dead key", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "nexus-machine-"));
    try {
      const env = { HOME: home, PATH: "/usr/bin" };
      saveMachineConfig(configPath(env), machineConfig());
      const answers = [heartbeatOk("active"), { status: 401, body: { code: "MACHINE_KEY_INVALID" } }];
      crm.respond = () => answers.shift() ?? heartbeatOk();
      const code = await main(["run"], {
        env,
        out: () => undefined,
        err: () => undefined,
        signal: new AbortController().signal,
        run: fakeRunner({ "git --version": { stdout: "git version 2.43.0" } }),
        fs: fakeFs({ executables: ["/usr/bin/git"] }),
        about: ABOUT,
        log: memoryLogger(),
        runOptions: { sleep: async () => undefined },
      });
      expect(code).toBe(EXIT_CONFIG);
      expect(crm.requests).toHaveLength(2);
      const first = crm.requests[0]!.body as { capabilities: Capabilities };
      expectStrictHeartbeat(first);
      expect(first.capabilities.toolchains).toEqual([{ name: "git", version: "2.43.0" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
