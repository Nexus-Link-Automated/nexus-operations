/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- flooding in bursts */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { loadGatewayConfig } from "../src/config.ts";
import { originAllowed } from "../src/origin.ts";
import { createPlaneApi, PlaneApiError } from "../src/plane-api.ts";
import { CloseCode } from "../src/protocol.ts";
import { ORIGIN, startHarness, type Harness } from "./helpers/harness.ts";
import { USER_COOKIE, WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { ChatClient, settle, waitUntil } from "./helpers/ws-client.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * An upgrade request by hand, from a client that keeps its end of the connection open whatever the gateway
 * does, as a misbehaving one would.
 */
function stubbornUpgrade(port: number, path: string, headers: { origin?: string; cookie?: string | null } = {}) {
  const { origin = ORIGIN, cookie = USER_COOKIE } = headers;
  const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  const client = { socket, received: "", ended: false };
  socket.on("data", (chunk) => {
    client.received += chunk.toString("latin1");
  });
  socket.on("end", () => {
    client.ended = true;
  });
  socket.on("error", () => undefined);
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Origin: ${origin}`,
      ...(cookie ? [`Cookie: ${cookie}`] : []),
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

function portOf(activeHarness: Harness): number {
  return Number(new URL(activeHarness.baseUrl).port);
}

/** Whether `promise` settled within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), settle(ms).then(() => false)]);
}

/**
 * Stop reading at the TCP level and keep sending bursts until the gateway lets go of the socket. Returns whether
 * it did. The deadline only has to outlast filling the kernel's socket buffers.
 */
async function floodWithoutReading(activeHarness: Harness, client: ChatClient, send: () => void): Promise<boolean> {
  (client.socket as unknown as { _socket: Socket })._socket.pause();
  const deadline = Date.now() + 5_000;
  while (activeHarness.gateway.connectionCount > 0 && Date.now() < deadline) {
    for (let sent = 0; sent < 2_000; sent += 1) send();
    await settle(1);
  }
  return activeHarness.gateway.connectionCount === 0;
}

function errorsLogged(activeHarness: Harness) {
  return activeHarness.log.lines.filter((line) => line.level === "error");
}

describe("before asking the API", () => {
  it("asks it nothing once the gateway is full", async () => {
    harness = await startHarness({ config: { maxConnections: 1 } });
    await (await harness.open()).next("ready");
    const asked = harness.api.requests.length;
    expect(await harness.connect().closed()).toBe(CloseCode.tooManyRequests);
    expect(harness.api.requests.length).toBe(asked);
  });

  it("admits only as many as fit when connections arrive together", async () => {
    harness = await startHarness({ config: { maxConnections: 1 } });
    harness.api.delayMs = 100;
    const clients = [harness.connect(), harness.connect(), harness.connect()];
    await waitUntil(() => clients.filter((client) => client.closeCode === CloseCode.tooManyRequests).length === 2);
    await waitUntil(() => clients.some((client) => client.of("ready").length === 1));
    expect(harness.gateway.connectionCount).toBe(1);
  });

  it("answers a path it can't parse with a 400, and doesn't report it as its own error", async () => {
    harness = await startHarness();
    const client = stubbornUpgrade(portOf(harness), "//");
    await waitUntil(() => client.received.includes("\r\n\r\n"));
    client.socket.destroy();
    expect(client.received).toContain("400 Bad Request");
    expect(errorsLogged(harness)).toEqual([]);
    expect(harness.api.requests).toEqual([]);
  });
});

describe("a client that goes away or won't let go", () => {
  it("stops signing in a browser that hangs up, and doesn't report that as an error", async () => {
    harness = await startHarness();
    harness.api.delayMs = 1_500;
    const gone = harness.connect();
    await waitUntil(() => harness!.api.arrivedRequests >= 2);
    gone.socket.terminate();
    await waitUntil(() => harness!.api.abortedRequests >= 2, 1_000);
    await settle(30);
    expect(errorsLogged(harness)).toEqual([]);
    expect(harness.gateway.connectionCount).toBe(0);
  });

  it("stops signing in a browser whose connection is reset", async () => {
    harness = await startHarness();
    harness.api.delayMs = 1_500;
    const client = stubbornUpgrade(portOf(harness), `/chat/ws?workspace=${WORKSPACE_SLUG}`);
    await waitUntil(() => harness!.api.arrivedRequests >= 2);
    client.socket.resetAndDestroy();
    await waitUntil(() => harness!.api.abortedRequests >= 2, 1_000);
  });

  it("notices a hang-up even when the browser sent something first", async () => {
    harness = await startHarness();
    harness.api.delayMs = 1_500;
    const client = stubbornUpgrade(portOf(harness), `/chat/ws?workspace=${WORKSPACE_SLUG}`);
    await waitUntil(() => harness!.api.arrivedRequests >= 2);
    client.socket.end("early bytes");
    await waitUntil(() => harness!.api.abortedRequests >= 2, 1_000);
    client.socket.destroy();
  });

  it("gives up on a refused client that won't finish closing", async () => {
    harness = await startHarness({ config: { closeTimeoutMs: 100 } });
    const client = stubbornUpgrade(portOf(harness), `/chat/ws?workspace=${WORKSPACE_SLUG}`, { cookie: null });
    try {
      await waitUntil(() => client.received.includes("101 Switching Protocols"));
      await waitUntil(() => client.ended, 3_000);
    } finally {
      client.socket.destroy();
    }
  });

  it("closes a socket that has stopped reading its replies", async () => {
    harness = await startHarness({ config: { maxBufferedBytes: 1024, closeTimeoutMs: 100, rateFrames: 10_000_000 } });
    const client = await harness.open();
    await client.next("ready");
    expect(await floodWithoutReading(harness, client, () => client.socket.send("{}"))).toBe(true);
    client.socket.terminate();
  });

  it("closes a socket that sends pings without reading the answers", async () => {
    harness = await startHarness({ config: { maxBufferedBytes: 1024, closeTimeoutMs: 100, rateFrames: 10_000_000 } });
    const client = await harness.open();
    await client.next("ready");
    const payload = Buffer.alloc(125);
    expect(await floodWithoutReading(harness, client, () => client.socket.ping(payload))).toBe(true);
    client.socket.terminate();
  });

  it("closes its side of a request it refused over HTTP, so shutdown isn't stuck on it", async () => {
    harness = await startHarness();
    const client = stubbornUpgrade(portOf(harness), `/chat/ws?workspace=${WORKSPACE_SLUG}`, {
      origin: "https://evil.example",
    });
    try {
      await waitUntil(() => client.received.includes("\r\n\r\n"));
      expect(client.received).toContain("403 Forbidden");
      expect(await settlesWithin(harness.gateway.close(), 2_000)).toBe(true);
    } finally {
      client.socket.destroy();
    }
  });
});

describe("keepalive", () => {
  it("drops a browser that stops answering pings", async () => {
    harness = await startHarness({ config: { pingIntervalMs: 30 } });
    const url = `${harness.baseUrl}/chat/ws?workspace=${WORKSPACE_SLUG}`;
    const silent = new ChatClient(url, { Cookie: USER_COOKIE, Origin: ORIGIN }, { autoPong: false });
    await silent.next("ready");
    await waitUntil(() => harness!.gateway.connectionCount === 0);
    silent.socket.terminate();
  });

  it("keeps a browser that answers them", async () => {
    harness = await startHarness({ config: { pingIntervalMs: 30 } });
    const client = await harness.open();
    await client.next("ready");
    await settle(200);
    expect(client.closeCode).toBeUndefined();
    expect(harness.gateway.connectionCount).toBe(1);
  });
});

describe("shutting down", () => {
  it("stops promptly once its sockets have closed", async () => {
    harness = await startHarness();
    await (await harness.open()).next("ready");
    expect(await settlesWithin(harness.gateway.close(), 2_000)).toBe(true);
  });

  it("doesn't wait for a sign-in that is still in progress", async () => {
    harness = await startHarness();
    harness.api.delayMs = 1_500;
    const pending = harness.connect();
    await waitUntil(() => harness!.api.arrivedRequests >= 2);
    expect(await settlesWithin(harness.gateway.close(), 1_000)).toBe(true);
    expect(harness.gateway.connectionCount).toBe(0);
    expect(await pending.closed()).not.toBeUndefined();
  });
});

describe("configuration", () => {
  it("matches allowed origins however they were capitalised, as Django does", () => {
    const config = loadGatewayConfig({
      API_BASE_URL: "http://api:8000",
      REDIS_URL: "redis://valkey:6379",
      CORS_ALLOWED_ORIGINS: " https://App.Example.com/ ,http://other.test",
    });
    expect(config.allowedOrigins).toEqual(["https://app.example.com", "http://other.test"]);
  });
});

describe("the origin check with no origins configured", () => {
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it("takes the gateway's host from the proxy's header when there is one", () => {
    const headers = { host: "chat-gateway:3420", "x-forwarded-host": "plane.test" };
    expect(originAllowed(request({ ...headers, origin: "https://plane.test" }), [])).toBe(true);
    expect(originAllowed(request({ ...headers, origin: "https://chat-gateway:3420" }), [])).toBe(false);
  });
});

describe("the API client", () => {
  it("never follows a redirect, which would carry the cookie somewhere else", async () => {
    let redirect: string | undefined;
    const api = createPlaneApi({
      baseUrl: "http://api.test",
      fetch: (_url, init) => {
        redirect = init?.redirect;
        return Promise.resolve(new Response(null, { status: 302, headers: { Location: "http://elsewhere.test/" } }));
      },
    });
    await expect(api.currentUser(USER_COOKIE)).rejects.toMatchObject({ status: 302 });
    expect(redirect).toBe("manual");
  });

  it("gives up on an API that doesn't answer", async () => {
    const api = createPlaneApi({
      baseUrl: "http://api.test",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
        }),
    });
    await expect(api.currentUser(USER_COOKIE)).rejects.toMatchObject({ status: 0 });
  });

  it("lets go of the body of a refused request, so its connection can be reused", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const api = createPlaneApi({
      baseUrl: "http://api.test",
      fetch: () => Promise.resolve(new Response(body, { status: 403 })),
    });
    await expect(api.currentUser(USER_COOKIE)).rejects.toBeInstanceOf(PlaneApiError);
    expect(cancelled).toBe(true);
  });
});
