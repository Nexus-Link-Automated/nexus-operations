/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { z } from "zod";

const KiB = 1024;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  APP_VERSION: z.string().default("1.0.0"),
  HOST: z.string().default("0.0.0.0"),
  PORT: positiveInt(3420),
  API_BASE_URL: z.url("API_BASE_URL must be a valid URL"),
  CHAT_GATEWAY_BASE_PATH: z
    .string()
    .default("/chat")
    .transform((value) => `/${value.replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "")),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  CHAT_GATEWAY_MAX_MESSAGE_BYTES: positiveInt(16 * KiB),
  CHAT_GATEWAY_MAX_CONNECTIONS_PER_USER: positiveInt(8),
  CHAT_GATEWAY_MAX_CONNECTIONS: positiveInt(2000),
  CHAT_GATEWAY_PING_INTERVAL_MS: positiveInt(30_000),
});

export interface GatewayConfig {
  readonly version: string;
  readonly host: string;
  readonly port: number;
  /** Plane API origin, e.g. `http://api:8000`. The gateway only ever reads from it, with the user's own cookie. */
  readonly apiBaseUrl: string;
  /** Mount point; the socket is `<basePath>/ws`, health is `<basePath>/health`. */
  readonly basePath: string;
  /** Origins allowed to open the socket; empty allows the gateway's own host only. */
  readonly allowedOrigins: readonly string[];
  /** Largest frame accepted from a browser. */
  readonly maxMessageBytes: number;
  readonly maxConnectionsPerUser: number;
  readonly maxConnections: number;
  readonly pingIntervalMs: number;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid chat-gateway environment:\n  ${problems.join("\n  ")}`);
  }
  const e = result.data;
  return {
    version: e.APP_VERSION,
    host: e.HOST,
    port: e.PORT,
    apiBaseUrl: e.API_BASE_URL.replace(/\/+$/, ""),
    basePath: e.CHAT_GATEWAY_BASE_PATH,
    allowedOrigins: e.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    maxMessageBytes: e.CHAT_GATEWAY_MAX_MESSAGE_BYTES,
    maxConnectionsPerUser: e.CHAT_GATEWAY_MAX_CONNECTIONS_PER_USER,
    maxConnections: e.CHAT_GATEWAY_MAX_CONNECTIONS,
    pingIntervalMs: e.CHAT_GATEWAY_PING_INTERVAL_MS,
  };
}
