/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { once } from "node:events";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { WithWebsocketMethod } from "express-ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { MAX_COLLABORATION_MESSAGE_BYTES } from "@/lib/collaboration-socket-guard";

vi.mock("@/env", () => ({
  env: {
    PORT: 0,
    LIVE_BASE_PATH: "/live",
    COMPRESSION_LEVEL: 6,
    COMPRESSION_THRESHOLD: 1024,
    CORS_ALLOWED_ORIGINS: "",
  },
}));
vi.mock("@/controllers", () => ({ CONTROLLERS: [] }));
vi.mock("@/hocuspocus", () => ({ HocusPocusServerManager: { getInstance: vi.fn() } }));
vi.mock("@/redis", () => ({ redisManager: { disconnect: vi.fn() } }));

const { Server } = await import("@/server");

describe("WebSocket message size limit", () => {
  let httpServer: HttpServer;
  let url: string;
  const sockets: WebSocket[] = [];

  const connect = async () => {
    const socket = new WebSocket(url);
    socket.on("error", () => {});
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  };

  beforeAll(async () => {
    const app = (new Server() as unknown as { app: Express & WithWebsocketMethod }).app;
    app.ws("/limit-test", (socket) => {
      socket.on("error", () => {});
      socket.on("message", (data) => socket.send(String((data as Buffer).byteLength)));
    });
    httpServer = app.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/limit-test`;
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it("accepts a message the size of the largest document the API stores", async () => {
    const socket = await connect();
    const size = 10 * 1024 * 1024 + 1024;

    socket.send(Buffer.alloc(size));
    const [reply] = await once(socket, "message");

    expect(String(reply)).toBe(String(size));
  });

  it("closes the socket when a message is over the limit", async () => {
    const socket = await connect();

    socket.send(Buffer.alloc(MAX_COLLABORATION_MESSAGE_BYTES + 1));
    const [code] = await once(socket, "close");

    expect(code).toBe(1009);
  });
});
