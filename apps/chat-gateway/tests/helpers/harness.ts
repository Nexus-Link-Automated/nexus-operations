/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";

import { RedisEventBus, workspaceChannel, type EventBus } from "../../src/bus.ts";
import type { GatewayConfig } from "../../src/config.ts";
import type { ChatEvent } from "../../src/events.ts";
import type { Logger } from "../../src/logger.ts";
import { createPlaneApi } from "../../src/plane-api.ts";
import { ChatGateway } from "../../src/server.ts";
import { MemoryEventBus } from "./memory-bus.ts";
import { REDIS_URL } from "./redis.ts";
import { StubPlaneApi, USER_COOKIE, WORKSPACE_ID, WORKSPACE_SLUG } from "./stub-api.ts";
import { ChatClient, waitUntil } from "./ws-client.ts";

export const ORIGIN = "http://plane.test";

/** Every log line, so tests can check nothing secret is ever logged. */
export class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string; meta?: Record<string, unknown> | undefined }[] = [];
  debug = (message: string, meta?: Record<string, unknown>) => this.lines.push({ level: "debug", message, meta });
  info = (message: string, meta?: Record<string, unknown>) => this.lines.push({ level: "info", message, meta });
  warn = (message: string, meta?: Record<string, unknown>) => this.lines.push({ level: "warn", message, meta });
  error = (message: string, meta?: Record<string, unknown>) => this.lines.push({ level: "error", message, meta });
  text(): string {
    return JSON.stringify(this.lines);
  }
}

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    version: "test",
    host: "127.0.0.1",
    port: 0,
    apiBaseUrl: "http://127.0.0.1:1",
    redisUrl: REDIS_URL,
    basePath: "/chat",
    allowedOrigins: [ORIGIN],
    maxMessageBytes: 1024,
    maxConnectionsPerUser: 4,
    maxConnections: 100,
    pingIntervalMs: 30_000,
    maxBufferedBytes: 1024 * 1024,
    closeTimeoutMs: 5_000,
    maxApiConcurrency: 64,
    maxSubscriptions: 100,
    rateFrames: 100,
    rateWindowMs: 10_000,
    // High enough that only the tests about it reach it.
    rateChecks: 10_000,
    // Long enough that nothing re-checks by itself unless a test asks for it.
    accessTtlMs: 600_000,
    sessionRecheckMs: 600_000,
    ...overrides,
  };
}

/** A chat event as Django would publish it. */
export function chatEvent(type: ChatEvent["type"], fields: Partial<ChatEvent> = {}): ChatEvent {
  return { type, workspace_id: WORKSPACE_ID, at: new Date().toISOString(), ...fields };
}

/** The chat events a client was sent, without the markers `barrier()` uses. */
export function eventsOf(client: ChatClient): ChatEvent[] {
  return client
    .of("event")
    .map((frame) => frame.event as ChatEvent)
    .filter((event) => !event.actor_id?.startsWith("marker-"));
}

export interface ConnectOptions {
  /** The session cookie to send; `null` sends none. Default: Ada, a member of the workspace. */
  cookie?: string | null;
  /** The `Origin` header; `null` sends none. Default: an allowed origin. */
  origin?: string | null;
  workspace?: string | null;
}

export type BusKind = "memory" | "redis";

export interface Harness {
  readonly api: StubPlaneApi;
  readonly gateway: ChatGateway;
  readonly bus: EventBus;
  /** The name of the Redis connection the gateway listens on (with the Redis bus). */
  readonly busConnectionName: string;
  /** The in-memory bus, when that is what the gateway is using. */
  readonly memory: MemoryEventBus | undefined;
  readonly log: RecordingLogger;
  readonly baseUrl: string;
  connect(options?: ConnectOptions): ChatClient;
  /** Connect and wait for the socket to be live (`ready`). */
  open(options?: ConnectOptions | string): Promise<ChatClient>;
  /** Publish an event the way Django does, to the workspace's channel (the raw string, if given one). */
  publish(event: ChatEvent | string, workspaceId?: string): Promise<void>;
  /**
   * Wait until everything published so far has reached these clients, or been dropped, so a test can then say
   * what they did not get. Events from one publisher arrive in order, so a marker on `channelId` (a channel
   * all of them follow) that reaches them is behind everything published before it.
   */
  barrier(channelId: string, ...clients: ChatClient[]): Promise<void>;
  /** A plain HTTP request to the gateway. */
  http(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<GatewayConfig>;
  api?: StubPlaneApi;
  bus?: BusKind;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const api = await (options.api ?? new StubPlaneApi()).start();
  const log = new RecordingLogger();
  const config = testConfig({ apiBaseUrl: api.url, ...options.config });
  const kind = options.bus ?? "memory";
  const memory = kind === "memory" ? new MemoryEventBus() : undefined;
  const busConnectionName = `chat-gateway-test-${randomUUID()}`;
  const bus: EventBus = memory ?? new RedisEventBus({ url: config.redisUrl, log, connectionName: busConnectionName });
  const publisher = kind === "redis" ? new Redis(config.redisUrl) : undefined;
  publisher?.on("error", () => undefined);
  if (kind === "redis") await waitUntil(() => bus.connected);

  const gateway = new ChatGateway({
    config,
    api: createPlaneApi({ baseUrl: api.url, maxConcurrent: config.maxApiConcurrency }),
    bus,
    log,
  });
  const address = await gateway.listen(0, "127.0.0.1");
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  const clients: ChatClient[] = [];
  let markers = 0;

  const connect: Harness["connect"] = (opts = {}) => {
    const headers: Record<string, string> = {};
    const cookie = opts.cookie === undefined ? USER_COOKIE : opts.cookie;
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    const workspace = opts.workspace === undefined ? WORKSPACE_SLUG : opts.workspace;
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    const query = workspace === null ? "" : `?${new URLSearchParams({ workspace })}`;
    const client = new ChatClient(`${baseUrl}${config.basePath}/ws${query}`, headers);
    clients.push(client);
    return client;
  };

  const publish: Harness["publish"] = async (event, workspaceId = WORKSPACE_ID) => {
    const payload = typeof event === "string" ? event : JSON.stringify(event);
    if (memory) memory.publish(workspaceId, payload);
    else await publisher!.publish(workspaceChannel(workspaceId), payload);
  };

  return {
    api,
    gateway,
    bus,
    busConnectionName,
    memory,
    log,
    baseUrl,
    connect,
    async open(opts) {
      const client = connect(typeof opts === "string" ? { cookie: opts } : opts);
      await client.opened;
      await client.next("ready");
      return client;
    },
    publish,
    async barrier(channelId, ...waiting) {
      const marker = `marker-${(markers += 1)}`;
      await publish(chatEvent("channel.updated", { channel_id: channelId, actor_id: marker }));
      await Promise.all(
        waiting.map((client) => client.waitFor((frame) => (frame.event as ChatEvent | undefined)?.actor_id === marker))
      );
    },
    async http(path) {
      const response = await fetch(`${baseUrl.replace(/^ws:/, "http:")}${path}`);
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    async stop() {
      for (const client of clients) client.socket.terminate();
      await gateway.close();
      publisher?.disconnect();
      await api.stop();
    },
  };
}
