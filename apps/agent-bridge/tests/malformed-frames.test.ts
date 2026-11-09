/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { connect, type Socket } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ORIGIN, initialize, startHarness, type Harness } from "./helpers/harness.ts";
import { AGENT_ID, USER_COOKIE, WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { waitUntil } from "./helpers/ws-client.ts";

/** FIN plus a reserved opcode: `ws` rejects this before reading anything else. */
const MALFORMED_FRAME = Buffer.from([0x83, 0x00]);
const CLOSE_OPCODE = 0x08;

/** A masked (with an all-zero key) text frame short enough for the one-byte length form. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  expect(payload.length).toBeLessThan(126);
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, 0, 0, 0, 0]), payload]);
}

/**
 * A client that finishes the handshake over plain TCP. A WebSocket library would answer the
 * server's close frame at once, and would not write a malformed frame at all.
 */
class RawSocket {
  readonly socket: Socket;
  received = Buffer.alloc(0);

  constructor(port: number, cookie?: string) {
    this.socket = connect(port, "127.0.0.1");
    this.socket.on("error", () => undefined);
    this.socket.on("data", (chunk) => {
      this.received = Buffer.concat([this.received, chunk]);
    });
    this.socket.write(
      [
        `GET /agents/acp?agent=${AGENT_ID}&workspace=${WORKSPACE_SLUG} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Origin: ${ORIGIN}`,
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        "\r\n",
      ].join("\r\n")
    );
  }

  async upgraded(): Promise<void> {
    await waitUntil(() => this.received.includes("\r\n\r\n"));
    expect(this.received.toString("latin1")).toMatch(/^HTTP\/1\.1 101 /);
  }

  /** The bytes after the HTTP response, which are server frames. */
  get frames(): Buffer {
    return this.received.subarray(this.received.indexOf("\r\n\r\n") + 4);
  }

  write(bytes: Buffer): void {
    this.socket.write(bytes);
  }
}

describe("malformed WebSocket frames", () => {
  let harness: Harness | undefined;
  let raw: RawSocket | undefined;
  let uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);

  beforeEach(() => {
    uncaught = [];
    process.on("uncaughtException", onUncaught);
  });
  afterEach(async () => {
    process.off("uncaughtException", onUncaught);
    raw?.socket.destroy();
    raw = undefined;
    await harness?.stop();
    harness = undefined;
  });

  const open = async (cookie?: string) => {
    harness = await startHarness();
    raw = new RawSocket(Number(new URL(harness.baseUrl).port), cookie);
    await raw.upgraded();
    return { harness, raw };
  };

  /** The frame was handled when it was either logged or thrown; either way the verdict is in. */
  const sendMalformedFrame = async (target: Harness, socket: RawSocket) => {
    socket.write(MALFORMED_FRAME);
    await waitUntil(() => uncaught.length > 0 || target.log.text().includes("websocket error"));
    expect(uncaught).toEqual([]);
  };

  it("survives one on a connection that was refused", async () => {
    const { harness: target, raw: socket } = await open();
    await sendMalformedFrame(target, socket);

    // The bridge keeps serving.
    const client = await target.open();
    expect((await initialize(client)).result).toBeDefined();
  });

  it("survives one while a session is closing, after the SDK has dropped its listener", async () => {
    const { harness: target, raw: socket } = await open(USER_COOKIE);
    socket.write(
      textFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {} },
        })
      )
    );
    const agent = await waitUntil(() => {
      const candidate = target.transport.agents[0];
      return candidate?.received.some((message) => message.method === "initialize") ? candidate : undefined;
    });

    // The agent side ending makes the bridge close the socket; this client never answers the close.
    agent.channel.close();
    await waitUntil(() => closeFrameSeen(socket));
    // The SDK's outbound pump notices the closed agent a moment after the close frame goes out.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await sendMalformedFrame(target, socket);
    const client = await target.open();
    expect((await initialize(client)).result).toBeDefined();
  });
});

/** Whether a close frame is among the frames received so far. */
function closeFrameSeen(socket: RawSocket): boolean {
  let offset = 0;
  const { frames } = socket;
  while (offset + 2 <= frames.length) {
    const opcode = frames[offset]! & 0x0f;
    if (opcode === CLOSE_OPCODE) return true;
    let length = frames[offset + 1]! & 0x7f;
    offset += 2;
    if (length === 126) {
      length = frames.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(frames.readBigUInt64BE(offset));
      offset += 8;
    }
    offset += length;
  }
  return false;
}
