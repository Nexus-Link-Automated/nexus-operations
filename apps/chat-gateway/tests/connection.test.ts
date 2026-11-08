/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Connection } from "../src/connection.ts";
import { Hub } from "../src/hub.ts";
import { silentLogger } from "../src/logger.ts";
import type { ChannelAccess } from "../src/plane-api.ts";
import { CloseCode } from "../src/protocol.ts";
import { chatEvent, testConfig } from "./helpers/harness.ts";
import { MemoryEventBus } from "./helpers/memory-bus.ts";
import { ADA, WORKSPACE_ID } from "./helpers/stub-api.ts";

/** Just enough of a WebSocket to see what a `Connection` does with it. */
class FakeSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: { type: string }[] = [];
  closedWith: [number, string] | undefined;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string });
  }
  close(code: number, reason: string): void {
    this.closedWith = [code, reason];
    this.readyState = 3;
  }
}

async function liveConnection(channel: string) {
  const socket = new FakeSocket();
  const bus = new MemoryEventBus();
  const connection = new Connection({
    socket: socket as unknown as WebSocket,
    userId: ADA.id,
    workspace: { id: WORKSPACE_ID, slug: "acme" },
    cookie: ADA.cookie,
    config: testConfig({ maxBufferedBytes: 1000 }),
    api: {
      currentUser: async () => ({ id: ADA.id }),
      workspace: async () => ({ id: WORKSPACE_ID }),
      channels: async (_cookie, _slug, archived) => (archived ? [] : [{ id: channel, is_member: true }]),
      channel: async () => ({ id: channel, is_member: true }),
    },
    hub: new Hub({ bus, log: silentLogger }),
    log: silentLogger,
    onClose: () => undefined,
  });
  await connection.start();
  return { socket, connection };
}

/** A live connection whose channel re-reads wait to be answered, so a test can say what happens in between. */
async function heldReads(channel: string, overrides: { accessTtlMs?: number } = {}) {
  const socket = new FakeSocket();
  const pending: ((rows: ChannelAccess[]) => void)[] = [];
  let holding = false;
  const connection = new Connection({
    socket: socket as unknown as WebSocket,
    userId: ADA.id,
    workspace: { id: WORKSPACE_ID, slug: "acme" },
    cookie: ADA.cookie,
    config: testConfig(overrides),
    api: {
      currentUser: async () => ({ id: ADA.id }),
      workspace: async () => ({ id: WORKSPACE_ID }),
      channels: async (_cookie, _slug, archived) => {
        if (archived) return [];
        if (!holding) return [{ id: channel, is_member: true }];
        return new Promise<ChannelAccess[]>((resolve) => pending.push(resolve));
      },
      channel: async () => ({ id: channel, is_member: true }),
    },
    hub: new Hub({ bus: new MemoryEventBus(), log: silentLogger }),
    log: silentLogger,
    onClose: () => undefined,
  });
  await connection.start();
  holding = true;
  return { socket, connection, pending };
}

/** Let everything already able to run, run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const memberRow = (id: string) => [{ id, is_member: true }];
const eventFrames = (socket: FakeSocket) =>
  socket.sent.filter((frame) => frame.type === "event") as unknown as { event: { type: string; message_id?: string } }[];

describe("while access is being re-checked", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("still takes a removal into account, so a stale answer can't bring the channel back", async () => {
    vi.useFakeTimers();
    const channel = randomUUID();
    const { socket, connection, pending } = await heldReads(channel);

    connection.deliver(chatEvent("access.revoked", { user_id: ADA.id }));
    await flush();
    expect(pending).toHaveLength(1);
    // Taken out while the channels are being read: the read may already be out of date.
    connection.deliver(chatEvent("member.removed", { channel_id: channel, user_id: ADA.id }));
    pending.shift()!(memberRow(channel));
    await flush();
    if (pending.length > 0) pending.shift()!([]);
    await flush();

    const hello = chatEvent("message.created", { channel_id: channel, message_id: randomUUID() });
    connection.deliver(hello);
    expect(eventFrames(socket).filter((frame) => frame.event.type === "message.created")).toEqual([]);
  });
});

describe("re-reading the user's channels", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drops a read that events kept overtaking, rather than apply it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const channel = randomUUID();
    const { socket, connection, pending } = await heldReads(channel, { accessTtlMs: 1000 });
    const own = (other: string) => chatEvent("member.added", { channel_id: other, user_id: ADA.id });

    await vi.advanceTimersByTimeAsync(1000);
    expect(pending).toHaveLength(1);
    connection.deliver(own(randomUUID()));
    pending.shift()!(memberRow(channel));
    await flush();
    expect(pending).toHaveLength(1);
    connection.deliver(own(randomUUID()));
    pending.shift()!(memberRow(channel));
    await flush();
    expect(pending).toHaveLength(1);
    // The last permitted attempt, and the user is taken out while it is under way.
    connection.deliver(chatEvent("member.removed", { channel_id: channel, user_id: ADA.id }));
    pending.shift()!(memberRow(channel));
    await flush();

    connection.deliver(chatEvent("message.created", { channel_id: channel, message_id: randomUUID() }));
    expect(eventFrames(socket).filter((frame) => frame.event.type === "message.created")).toEqual([]);
  });

  it("spreads its re-reads across the interval, so sockets opened together don't re-read together", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const channel = randomUUID();
    const { pending } = await heldReads(channel, { accessTtlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(pending).toHaveLength(1);
  });
});

describe("a socket that closes while it is starting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves no timers running", async () => {
    vi.useFakeTimers();
    const channel = randomUUID();
    const socket = new FakeSocket();
    socket.bufferedAmount = 5000;
    const connection = new Connection({
      socket: socket as unknown as WebSocket,
      userId: ADA.id,
      workspace: { id: WORKSPACE_ID, slug: "acme" },
      cookie: ADA.cookie,
      config: testConfig({ maxBufferedBytes: 1000 }),
      api: {
        currentUser: async () => ({ id: ADA.id }),
        workspace: async () => ({ id: WORKSPACE_ID }),
        channels: async () => [{ id: channel, is_member: true }],
        channel: async () => ({ id: channel, is_member: true }),
      },
      hub: new Hub({ bus: new MemoryEventBus(), log: silentLogger }),
      log: silentLogger,
      onClose: () => undefined,
    });
    await connection.start();
    expect(socket.closedWith).toEqual([CloseCode.tryAgainLater, "Not keeping up"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a socket that can't keep up", () => {
  it("is dropped, not buffered without limit", async () => {
    const channel = randomUUID();
    const { socket, connection } = await liveConnection(channel);
    expect(socket.sent.map((frame) => frame.type)).toEqual(["ready"]);

    socket.bufferedAmount = 5000;
    connection.deliver(chatEvent("message.created", { channel_id: channel, message_id: randomUUID() }));

    expect(socket.closedWith).toEqual([CloseCode.tryAgainLater, "Not keeping up"]);
    expect(socket.sent.map((frame) => frame.type)).toEqual(["ready"]);
    expect(connection.closed).toBe(true);
  });

  it("is sent to normally while it keeps up", async () => {
    const channel = randomUUID();
    const { socket, connection } = await liveConnection(channel);
    socket.bufferedAmount = 500;
    connection.deliver(chatEvent("message.created", { channel_id: channel, message_id: randomUUID() }));
    expect(socket.sent.map((frame) => frame.type)).toEqual(["ready", "event"]);
    expect(socket.closedWith).toBeUndefined();
  });

  it("is sent nothing once closed", async () => {
    const channel = randomUUID();
    const { socket, connection } = await liveConnection(channel);
    connection.close(CloseCode.forbidden, "Out");
    connection.deliver(chatEvent("message.created", { channel_id: channel, message_id: randomUUID() }));
    connection.resync("events_missed");
    expect(socket.sent.map((frame) => frame.type)).toEqual(["ready"]);
  });
});
