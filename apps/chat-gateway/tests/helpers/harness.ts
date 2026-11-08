/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { GatewayConfig } from "../../src/config.ts";
import type { Logger } from "../../src/logger.ts";
import { createPlaneApi } from "../../src/plane-api.ts";
import { ChatGateway } from "../../src/server.ts";
import { StubPlaneApi, USER_COOKIE, WORKSPACE_SLUG } from "./stub-api.ts";
import { ChatClient } from "./ws-client.ts";

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
    basePath: "/chat",
    allowedOrigins: [ORIGIN],
    maxMessageBytes: 1024,
    maxConnectionsPerUser: 4,
    maxConnections: 100,
    pingIntervalMs: 30_000,
    maxBufferedBytes: 1024 * 1024,
    closeTimeoutMs: 5_000,
    ...overrides,
  };
}

export interface ConnectOptions {
  /** The session cookie to send; `null` sends none. Default: a signed-in member. */
  cookie?: string | null;
  /** The `Origin` header; `null` sends none. Default: an allowed origin. */
  origin?: string | null;
  workspace?: string | null;
}

export interface Harness {
  readonly api: StubPlaneApi;
  readonly gateway: ChatGateway;
  readonly log: RecordingLogger;
  readonly baseUrl: string;
  connect(options?: ConnectOptions): ChatClient;
  /** Connect and wait for the socket to open. */
  open(options?: ConnectOptions): Promise<ChatClient>;
  /** A plain HTTP request to the gateway. */
  http(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
  stop(): Promise<void>;
}

export async function startHarness(
  options: { config?: Partial<GatewayConfig>; api?: StubPlaneApi } = {}
): Promise<Harness> {
  const api = await (options.api ?? new StubPlaneApi()).start();
  const log = new RecordingLogger();
  const config = testConfig({ apiBaseUrl: api.url, ...options.config });
  const gateway = new ChatGateway({ config, api: createPlaneApi({ baseUrl: api.url }), log });
  const address = await gateway.listen(0, "127.0.0.1");
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  const clients: ChatClient[] = [];
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
  return {
    api,
    gateway,
    log,
    baseUrl,
    connect,
    async open(opts) {
      const client = connect(opts);
      await client.opened;
      return client;
    },
    async http(path) {
      const response = await fetch(`${baseUrl.replace(/^ws:/, "http:")}${path}`);
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    },
    async stop() {
      for (const client of clients) client.socket.terminate();
      await gateway.close();
      await api.stop();
    },
  };
}
