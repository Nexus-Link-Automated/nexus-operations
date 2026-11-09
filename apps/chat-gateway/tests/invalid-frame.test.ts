/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomBytes } from "node:crypto";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CloseCode } from "../src/protocol.ts";
import { ORIGIN, startHarness, type Harness } from "./helpers/harness.ts";
import { WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { waitUntil } from "./helpers/ws-client.ts";

/** A frame with reserved bits set, which no WebSocket implementation may send. */
const INVALID_FRAME = Buffer.from([0xf1, 0x80]);

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** A WebSocket handshake by hand, so the test can send bytes that a real client would refuse to. */
function rawUpgrade(port: number, path: string) {
  const socket = connect(port, "127.0.0.1");
  const client = { socket, received: Buffer.alloc(0), ended: false };
  socket.on("data", (chunk) => {
    client.received = Buffer.concat([client.received, chunk]);
  });
  socket.on("close", () => {
    client.ended = true;
  });
  socket.on("error", () => undefined);
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Origin: ${ORIGIN}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "",
      "",
    ].join("\r\n")
  );
  return client;
}

describe("an invalid frame", () => {
  it("on a socket being refused ends that socket, not the process", async () => {
    harness = await startHarness();
    const bystander = await harness.open();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const { port } = new URL(harness.baseUrl);
      // No cookie: the handshake completes, and the gateway says why it's closing with a close frame.
      const client = rawUpgrade(Number(port), `/chat/ws?workspace=${WORKSPACE_SLUG}`);
      const closeFrame = await waitUntil(() => {
        const headersEnd = client.received.indexOf("\r\n\r\n");
        const frame = headersEnd === -1 ? undefined : client.received.subarray(headersEnd + 4);
        return frame && frame.length >= 4 ? frame : undefined;
      });
      expect(client.received.toString("latin1")).toContain("101 Switching Protocols");
      expect(closeFrame.readUInt16BE(2)).toBe(CloseCode.unauthenticated);

      client.socket.write(INVALID_FRAME);
      await waitUntil(() => client.ended);
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    expect(uncaught).toEqual([]);
    expect(bystander.closeCode).toBeUndefined();
    expect(harness.gateway.connectionCount).toBe(1);
    expect((await harness.http("/chat/health")).status).toBe(200);
  });
});
