/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it } from "vitest";

import { CloseCode } from "../src/protocol.ts";
import { ORIGIN, startHarness, type Harness } from "./helpers/harness.ts";
import { OUTSIDER_COOKIE, USER_COOKIE, USER_ID, WORKSPACE_ID, WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { ChatClient, settle, waitUntil } from "./helpers/ws-client.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("admission", () => {
  it("serves health", async () => {
    harness = await startHarness();
    const { status, body } = await harness.http("/chat/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "OK", connections: 0 });
  });

  it("lets a signed-in member of the workspace connect", async () => {
    harness = await startHarness();
    const client = await harness.open();
    const ready = await client.next("ready");
    expect(ready).toEqual({ type: "ready", user_id: USER_ID, workspace_id: WORKSPACE_ID, channels: [] });
    expect(client.closeCode).toBeUndefined();
    expect(harness.gateway.connectionCount).toBe(1);
  });

  it("asks the API about the user's own cookie, and nothing else", async () => {
    harness = await startHarness();
    await (await harness.open()).next("ready");
    expect(harness.api.requests.map((r) => `${r.method} ${r.path}`).toSorted()).toEqual([
      `GET /api/users/me/`,
      `GET /api/workspaces/${WORKSPACE_SLUG}/chat/channels/access/`,
      `GET /api/workspaces/${WORKSPACE_SLUG}/chat/me/`,
    ]);
    expect(harness.api.requests.every((r) => r.cookie === USER_COOKIE)).toBe(true);
  });

  it("reads the full channel lists from an API that predates the channel access route", async () => {
    harness = await startHarness({ config: { accessTtlMs: 50 } });
    const access = `/api/workspaces/${WORKSPACE_SLUG}/chat/channels/access/`;
    harness.api.failPaths.set(access, 404);
    const live = harness.api.addChannel({ members: [USER_ID] });
    const archived = harness.api.addChannel({ kind: "private", members: [USER_ID], archived: true });
    harness.api.addChannel();

    const ready = await (await harness.open()).next("ready");
    expect(new Set(ready.channels as string[])).toEqual(new Set([live, archived]));
    // Asked once, then left alone until the retry period ends, however often the channels are re-read.
    const lists = `/api/workspaces/${WORKSPACE_SLUG}/chat/channels/?archived=`;
    await waitUntil(() => harness!.api.requestsTo(lists).length >= 6);
    expect(harness.api.requestsTo(access)).toHaveLength(1);
  });

  it("refuses a connection without a cookie, without calling the API", async () => {
    harness = await startHarness();
    const client = harness.connect({ cookie: null });
    expect(await client.closed()).toBe(CloseCode.unauthenticated);
    expect(client.frames).toEqual([]);
    expect(harness.api.requests).toEqual([]);
    expect(harness.gateway.connectionCount).toBe(0);
  });

  it.each([403, 401])("refuses a cookie the API does not recognise (answered %i)", async (status) => {
    harness = await startHarness();
    harness.api.unauthenticatedStatus = status;
    const client = harness.connect({ cookie: "session-id=forged" });
    expect(await client.closed()).toBe(CloseCode.unauthenticated);
    expect(client.frames).toEqual([]);
  });

  it("refuses a signed-in user who is not a member of the workspace", async () => {
    harness = await startHarness();
    const client = harness.connect({ cookie: OUTSIDER_COOKIE });
    expect(await client.closed()).toBe(CloseCode.forbidden);
    expect(client.frames).toEqual([]);
  });

  it("refuses a user the workspace has removed", async () => {
    harness = await startHarness();
    harness.api.members.delete(USER_ID);
    expect(await harness.connect().closed()).toBe(CloseCode.forbidden);
  });

  it("refuses a workspace that does not exist", async () => {
    harness = await startHarness();
    expect(await harness.connect({ workspace: "nowhere" }).closed()).toBe(CloseCode.forbidden);
  });

  it("refuses a missing or malformed workspace before calling the API", async () => {
    harness = await startHarness();
    expect(await harness.connect({ workspace: null }).closed()).toBe(CloseCode.badRequest);
    expect(await harness.connect({ workspace: "../etc" }).closed()).toBe(CloseCode.badRequest);
    expect(await harness.connect({ workspace: "a".repeat(65) }).closed()).toBe(CloseCode.badRequest);
    expect(harness.api.requests).toEqual([]);
  });

  it("reports an API outage as a server problem, not a sign-in one", async () => {
    harness = await startHarness();
    harness.api.failWith = 500;
    const client = harness.connect();
    expect(await client.closed()).toBe(CloseCode.internalError);
    expect(harness.log.text()).toContain("could not authenticate");
  });

  it("reports an unreachable API the same way", async () => {
    harness = await startHarness();
    await harness.api.stop();
    expect(await harness.connect().closed()).toBe(CloseCode.internalError);
  });

  it("does not take a cookie from the URL", async () => {
    harness = await startHarness();
    const url = `${harness.baseUrl}/chat/ws?workspace=${WORKSPACE_SLUG}&cookie=${encodeURIComponent(USER_COOKIE)}`;
    const client = new ChatClient(url, { Origin: ORIGIN });
    expect(await client.closed()).toBe(CloseCode.unauthenticated);
    expect(harness.api.requests).toEqual([]);
  });
});

describe("the upgrade request", () => {
  it("refuses a cross-origin page at the HTTP level", async () => {
    harness = await startHarness();
    const client = harness.connect({ origin: "https://evil.example" });
    await client.closed();
    expect(client.unexpectedStatus).toBe(403);
    expect(harness.api.requests).toEqual([]);
  });

  it("allows a request with no Origin (not a browser)", async () => {
    harness = await startHarness();
    const client = await harness.open({ origin: null });
    expect((await client.next("ready")).type).toBe("ready");
  });

  it("allows the gateway's own host when no origins are configured", async () => {
    harness = await startHarness({ config: { allowedOrigins: [] } });
    const port = new URL(harness.baseUrl).port;
    const same = await harness.open({ origin: `http://127.0.0.1:${port}` });
    expect(same.closeCode).toBeUndefined();
    const other = harness.connect({ origin: ORIGIN });
    await other.closed();
    expect(other.unexpectedStatus).toBe(403);
  });

  it("answers any other path with a 404", async () => {
    harness = await startHarness();
    const client = new ChatClient(`${harness.baseUrl}/elsewhere?workspace=${WORKSPACE_SLUG}`, {
      Cookie: USER_COOKIE,
      Origin: ORIGIN,
    });
    await client.closed();
    expect(client.unexpectedStatus).toBe(404);
    expect((await harness.http("/chat/nope")).status).toBe(404);
  });

  it("honours a different base path", async () => {
    harness = await startHarness({ config: { basePath: "/messages-live" } });
    expect((await harness.http("/messages-live/health")).status).toBe(200);
    expect((await (await harness.open()).next("ready")).type).toBe("ready");
  });
});

describe("limits", () => {
  it("caps connections per user and frees the slot on disconnect", async () => {
    harness = await startHarness({ config: { maxConnectionsPerUser: 2 } });
    const first = await harness.open();
    await harness.open();
    const third = harness.connect();
    expect(await third.closed()).toBe(CloseCode.tooManyRequests);
    first.socket.close();
    await waitUntil(() => harness!.gateway.connectionCount === 1);
    expect((await (await harness.open()).next("ready")).type).toBe("ready");
  });

  it("caps connections overall", async () => {
    harness = await startHarness({ config: { maxConnections: 1 } });
    await harness.open();
    expect(await harness.connect().closed()).toBe(CloseCode.tooManyRequests);
  });

  it("does not hold a slot for a browser that left during sign-in", async () => {
    harness = await startHarness({ config: { maxConnectionsPerUser: 1 } });
    harness.api.delayMs = 150;
    const gone = harness.connect();
    await settle(30);
    gone.socket.terminate();
    await waitUntil(() => harness!.api.requests.length >= 2);
    await settle(250);
    harness.api.delayMs = 0;
    expect(harness.gateway.connectionCount).toBe(0);
    expect((await (await harness.open()).next("ready")).type).toBe("ready");
  });
});

describe("the socket", () => {
  it("answers a ping", async () => {
    harness = await startHarness();
    const client = await harness.open();
    client.send({ type: "ping" });
    expect((await client.next("pong")).type).toBe("pong");
  });

  it("answers a frame it can't use with an error and stays open", async () => {
    harness = await startHarness();
    const client = await harness.open();
    client.socket.send("not json");
    client.socket.send(Buffer.from([1, 2, 3]));
    client.send({ type: "teleport" });
    await waitUntil(() => client.of("error").length === 3);
    expect(client.of("error").every((frame) => frame.code === "bad_request")).toBe(true);
    expect(client.closeCode).toBeUndefined();
  });

  it("closes a socket that sends a frame over the size limit", async () => {
    harness = await startHarness({ config: { maxMessageBytes: 256 } });
    const client = await harness.open();
    client.socket.send("x".repeat(1024));
    expect(await client.closed()).toBe(1009);
  });

  it("closes sockets when it shuts down", async () => {
    harness = await startHarness();
    const client = await harness.open();
    await client.next("ready");
    await harness.gateway.close();
    expect(await client.closed()).toBe(CloseCode.goingAway);
    expect(harness.gateway.connectionCount).toBe(0);
  });

  it("never logs the cookie", async () => {
    harness = await startHarness();
    const client = await harness.open();
    await client.next("ready");
    harness.connect({ cookie: "session-id=forged-secret" });
    harness.api.failWith = 500;
    await harness.connect().closed();
    client.socket.close();
    await waitUntil(() => harness!.gateway.connectionCount === 0);
    const logged = harness.log.text();
    expect(logged).toContain("socket opened");
    expect(logged).not.toContain("user-session");
    expect(logged).not.toContain("forged-secret");
  });
});
