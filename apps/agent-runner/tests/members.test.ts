/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- requests in order */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SpawnClaims } from "@plane/agent-runner-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { defaultKiller } from "../src/agent-process.ts";
import type { AgentRunner } from "../src/server.ts";
import {
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  acpClient,
  authCall,
  isAlive,
  loginTicket,
  startRunner,
  tempRoot,
  ticket,
  upgradeStatus,
  waitUntil,
} from "./helpers.ts";

const LOGIN_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-login.mjs");

let runner: AgentRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

const membersTicket = () => ticket({ adapter: "none", env: {}, initialMode: "ask_all", purpose: "members" });
const offboardTicket = (overrides: Partial<SpawnClaims> = {}) =>
  ticket({ adapter: "none", env: {}, initialMode: "ask_all", purpose: "offboard", ...overrides });

async function call(
  wsUrl: string,
  method: "GET" | "POST",
  route: string,
  token: string | null
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = wsUrl.replace(/^ws:/, "http:").replace(/\/acp$/, "");
  const response = await fetch(`${base}${route}`, {
    method,
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const dirsOf = (root: string, userId: string) => [
  path.join(root, WORKSPACE_ID, userId),
  path.join(root, ".homes", WORKSPACE_ID, userId),
  path.join(root, ".tmp", WORKSPACE_ID, userId),
];

/** Start an echo agent for `userId` and wait until it runs. */
async function openAgent(url: string, userId: string) {
  const client = acpClient(url, { Authorization: `Bearer ${ticket({ userId, sessionRef: userId })}` });
  await client.agent.request("initialize", { protocolVersion: 1 });
  return client;
}

describe("runner /members", () => {
  it("lists the members with directories, for a members ticket only", async () => {
    const root = tempRoot();
    const started = await startRunner(root);
    runner = started.runner;
    await runner.workspaces.prepare(WORKSPACE_ID, USER_ID);
    await runner.workspaces.prepare(WORKSPACE_ID, OTHER_USER_ID);
    mkdirSync(path.join(root, WORKSPACE_ID, "not-a-uuid"));

    const listed = await call(started.url, "GET", "/members", membersTicket());
    expect(listed.status).toBe(200);
    expect(listed.body.members).toEqual(
      expect.arrayContaining([
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        { workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID },
      ])
    );
    expect(listed.body.members).toHaveLength(2);

    expect((await call(started.url, "GET", "/members", null)).status).toBe(401);
    expect((await call(started.url, "GET", "/members", ticket())).status).toBe(401);
    expect((await call(started.url, "GET", "/members", offboardTicket())).status).toBe(401);
    // Only an offboard ticket can delete anything.
    for (const token of [ticket(), loginTicket(), membersTicket()]) {
      expect((await call(started.url, "POST", "/members/offboard", token)).status).toBe(401);
    }
    for (const dir of dirsOf(root, USER_ID)) expect(existsSync(dir)).toBe(true);
    // Neither kind can start an agent.
    expect(await upgradeStatus(started.url, { Authorization: `Bearer ${membersTicket()}` })).toBe(401);
    expect(await upgradeStatus(started.url, { Authorization: `Bearer ${offboardTicket()}` })).toBe(401);
  });

  it("stops the member's agents and sign-ins and deletes their directories, leaving others alone", async () => {
    const root = tempRoot();
    const started = await startRunner(root, {
      loginHelper: { command: process.execPath, args: [LOGIN_FIXTURE] },
    });
    runner = started.runner;
    const mine = await openAgent(started.url, USER_ID);
    const theirs = await openAgent(started.url, OTHER_USER_ID);
    const myPid = await waitUntil(() => runner!.agents().find((agent) => agent.sessionRef === USER_ID)?.pid);
    expect(runner.agents()).toHaveLength(2);
    const signIn = await authCall(started.url, "start", { method: "POST" });
    expect(signIn.status).toBe(200);
    for (const dir of [...dirsOf(root, USER_ID), ...dirsOf(root, OTHER_USER_ID)]) {
      writeFileSync(path.join(dir, "notes.txt"), "kept until offboarding");
    }

    const offboarded = await call(started.url, "POST", "/members/offboard", offboardTicket());
    expect(offboarded).toEqual({ status: 200, body: { status: "removed" } });

    for (const dir of dirsOf(root, USER_ID)) expect(existsSync(dir)).toBe(false);
    for (const dir of dirsOf(root, OTHER_USER_ID)) expect(existsSync(path.join(dir, "notes.txt"))).toBe(true);
    expect(runner.agents().map((agent) => agent.sessionRef)).toEqual([OTHER_USER_ID]);
    expect(isAlive(myPid)).toBe(false);
    const status = await authCall(started.url, `status?loginId=${String(signIn.body.loginId)}`);
    expect(status.body).toEqual({ status: "failed", error: "The sign-in was stopped" });
    const listed = await call(started.url, "GET", "/members", membersTicket());
    expect(listed.body.members).toEqual([{ workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID }]);

    // Offboarding is idempotent, and a member who comes back starts from scratch.
    expect((await call(started.url, "POST", "/members/offboard", offboardTicket())).status).toBe(200);
    const again = await openAgent(started.url, USER_ID);
    expect(existsSync(path.join(root, WORKSPACE_ID, USER_ID, "notes.txt"))).toBe(false);
    for (const client of [mine, theirs, again]) client.close();
  });

  it("kills what still runs as the member's uid and refuses new agents until it is done", async () => {
    const root = tempRoot();
    const signalled: [number, string][] = [];
    let releaseListing!: () => void;
    const listingHeld = new Promise<void>((resolve) => {
      releaseListing = resolve;
    });
    let holdListing = false;
    let listingReached = false;
    const started = await startRunner(root, {
      config: { isolation: "uid" },
      chown: async () => undefined,
      spawner: (command, args, options) => {
        const { uid: _uid, gid: _gid, ...rest } = options;
        return spawn(command, args, rest);
      },
      killer: (pid, signal) => {
        signalled.push([pid, signal]);
        if (Math.abs(pid) < 900_000) defaultKiller(pid, signal);
      },
      listProcesses: async () => {
        if (holdListing) {
          listingReached = true;
          await listingHeld;
        }
        return [
          { pid: 900_001, uid: 20_000 },
          { pid: 900_002, uid: 20_001 },
        ];
      },
    });
    runner = started.runner;
    await runner.workspaces.prepare(WORKSPACE_ID, USER_ID);
    await runner.workspaces.prepare(WORKSPACE_ID, OTHER_USER_ID);
    signalled.length = 0;

    holdListing = true;
    const offboarding = call(started.url, "POST", "/members/offboard", offboardTicket());
    await waitUntil(() => listingReached);
    expect(await upgradeStatus(started.url, { Authorization: `Bearer ${ticket()}` })).toBe(409);
    releaseListing();

    expect((await offboarding).status).toBe(200);
    expect(signalled).toContainEqual([900_001, "SIGKILL"]);
    expect(signalled).not.toContainEqual([900_002, "SIGKILL"]);
    for (const dir of dirsOf(root, USER_ID)) expect(existsSync(dir)).toBe(false);
    // The uid stays the member's.
    holdListing = false;
    expect((await runner.workspaces.prepare(WORKSPACE_ID, USER_ID)).uid).toBe(20_000);
  });
});
