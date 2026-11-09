/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { CloseCode } from "../src/protocol.ts";
import { chatEvent, eventsOf, startHarness, type Harness } from "./helpers/harness.ts";
import { killSubscriber, redisAvailable } from "./helpers/redis.ts";
import { ADA, BEN, WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { settle, waitUntil } from "./helpers/ws-client.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const message = (channel_id: string) => chatEvent("message.created", { channel_id, message_id: randomUUID() });

describe("the event bus going wrong", () => {
  it("tells every socket to resync when events may have been missed", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id, BEN.id] });
    const ada = await h.open(ADA.cookie);
    const ben = await h.open(BEN.cookie);
    h.memory!.triggerGap();
    const frames = await Promise.all([ada, ben].map((client) => client.next("resync")));
    expect(frames).toEqual([
      { type: "resync", reason: "events_missed" },
      { type: "resync", reason: "events_missed" },
    ]);
    expect(ada.closeCode).toBeUndefined();
  });

  it("refuses a socket while there are no events to send it", async () => {
    h = await startHarness();
    h.memory!.connected = false;
    expect(await h.connect({ cookie: ADA.cookie }).closed()).toBe(CloseCode.internalError);
    expect((await h.http("/chat/health")).body).toMatchObject({ live: false });
  });

  it("closes a socket whose workspace it can't subscribe to, and forgets the workspace", async () => {
    h = await startHarness();
    h.memory!.subscribe = async () => {
      throw new Error("redis went away");
    };
    const ada = h.connect({ cookie: ADA.cookie });
    expect(await ada.closed()).toBe(CloseCode.internalError);
    expect(ada.of("ready")).toEqual([]);
    expect((await h.http("/chat/health")).body).toMatchObject({ workspaces: 0, connections: 0 });
  });
});

describe("events that arrive while a socket is still being set up", () => {
  it("are held until it is ready, then sent in order, and count", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    const room = h.api.addChannel({ kind: "private", members: [BEN.id] });
    h.api.delayPaths.set(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/`, 250);
    const ada = h.connect({ cookie: ADA.cookie });
    await waitUntil(() => h!.api.requestsTo(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/`).length === 2);

    // Ada is being put in `room` and someone writes in `home`, both while her channels are being read.
    const added = chatEvent("member.added", { channel_id: room, user_id: ADA.id });
    const first = message(home);
    const second = message(room);
    await h.publish(first);
    await h.publish(added);
    await h.publish(second);

    await ada.next("ready");
    await ada.waitFor((f) => (f.event as { message_id?: string })?.message_id === second.message_id);
    expect(ada.frames[0]!.type).toBe("ready");
    expect(eventsOf(ada)).toEqual([first, added, second]);
  });

  it("make the socket reconnect rather than pile up without limit", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    h.api.delayPaths.set(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/`, 400);
    const ada = h.connect({ cookie: ADA.cookie });
    await waitUntil(() => h!.api.requestsTo(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/`).length === 2);
    await Promise.all(Array.from({ length: 1100 }, () => h!.publish(message(home))));
    expect(await ada.closed()).toBe(CloseCode.tryAgainLater);
    expect(ada.of("ready")).toEqual([]);
  });

  it("leave nothing behind when the socket goes away during setup", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id] });
    h.api.delayPaths.set(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/`, 150);
    const ada = h.connect({ cookie: ADA.cookie });
    await waitUntil(() => h!.api.requestsTo(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/`).length === 2);
    ada.socket.terminate();
    await waitUntil(() => h!.gateway.connectionCount === 0);
    await settle(250);
    expect((await h.http("/chat/health")).body).toMatchObject({ workspaces: 0, connections: 0 });
    expect(h.memory!.subscribed.size).toBe(0);
  });
});

describe("how hard it leans on the API", () => {
  it("never asks it more than a limited number of things at once", async () => {
    h = await startHarness({ config: { maxApiConcurrency: 3, maxConnectionsPerUser: 20, maxConnections: 20 } });
    h.api.addChannel({ members: [ADA.id] });
    h.api.delayMs = 40;
    const clients = Array.from({ length: 12 }, () => h!.connect({ cookie: ADA.cookie }));
    await Promise.all(clients.map((client) => client.next("ready", 15_000)));
    expect(h.api.peakInFlight).toBeLessThanOrEqual(3);
    expect(h.gateway.connectionCount).toBe(12);
  });
});

describe("one user's tabs", () => {
  it("each get the events, and closing one leaves the other", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    const one = await h.open(ADA.cookie);
    const two = await h.open(ADA.cookie);
    one.socket.close();
    await waitUntil(() => h!.gateway.connectionCount === 1);
    const hello = message(home);
    await h.publish(hello);
    await two.waitFor((f) => f.type === "event");
    expect(eventsOf(two)).toEqual([hello]);
  });
});

describe.skipIf(!redisAvailable)("Redis dropping the gateway's connection", () => {
  it("tells sockets to resync once listening again, and then carries on", async () => {
    h = await startHarness({ bus: "redis" });
    const home = h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    await killSubscriber(h.busConnectionName);
    expect(await ada.next("resync")).toEqual({ type: "resync", reason: "events_missed" });

    // Resync is only sent after the subscription is back, so what is published now arrives.
    const after = message(home);
    await h.publish(after);
    await ada.waitFor((f) => f.type === "event");
    expect(eventsOf(ada)).toEqual([after]);
    expect(ada.closeCode).toBeUndefined();
  });
});
