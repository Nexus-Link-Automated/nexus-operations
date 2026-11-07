/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";

import { Connection } from "../src/connection.ts";
import { Hub } from "../src/hub.ts";
import { silentLogger } from "../src/logger.ts";
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
