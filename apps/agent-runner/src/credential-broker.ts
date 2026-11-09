/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { CLAUDE_BROKERED_ENV, CODEX_BASE_URL_ENV } from "./env.ts";
import type { Logger } from "./logger.ts";

const BROKER_HOST = "127.0.0.1";
// Vendor clients pool connections for longer than Node's 5 s default; closing an idle one under
// them turns the next request into a connection reset.
const KEEP_ALIVE_MS = 75_000;
const TOKEN_PREFIX = "pab_";
const AGENT_AUTH_ENV = "PLANE_AGENT_AUTH";

type AuthHeader = "authorization" | "x-api-key" | "x-goog-api-key";
const AUTH_HEADERS: readonly AuthHeader[] = ["authorization", "x-api-key", "x-goog-api-key"];

/**
 * How one vendor is brokered. `upstream` is fixed here: nothing from the agent, the ticket or the
 * request can change where a key is sent.
 */
interface BrokeredProvider {
  /** The agent env variable the adapter reads the key from. */
  readonly keyEnv: string;
  readonly upstream: string;
  /** The header the vendor's client sends the key in, and the upstream expects it in. */
  readonly authHeader: AuthHeader;
  /** The agent env variable that points the vendor's client at the broker. */
  readonly baseUrlEnv: string;
  /** Appended to the broker's URL: the part of the vendor's default base URL after the host. */
  readonly basePath: string;
  /** Extra env for the vendor's client while it talks to the broker. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Set in the agent's env, these send the key or the traffic somewhere the broker cannot serve. */
  readonly directIfSet: readonly string[];
  /** The `PLANE_AGENT_AUTH` value of the account sign-in, when the vendor has one. */
  readonly accountMode?: string;
}

/** Keyed by the ticket's adapter id. */
const BROKERED_PROVIDERS: Readonly<Record<string, BrokeredProvider>> = {
  claude: {
    keyEnv: "ANTHROPIC_API_KEY",
    upstream: "https://api.anthropic.com",
    authHeader: "x-api-key",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    basePath: "",
    // The SDK treats any other base URL as a third-party gateway and drops first-party betas and
    // model options. This one forwards unchanged to the Anthropic API, so it keeps them.
    extraEnv: { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1", [CLAUDE_BROKERED_ENV]: "1" },
    directIfSet: ["ANTHROPIC_BASE_URL", "ANTHROPIC_UNIX_SOCKET", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
  codex: {
    keyEnv: "OPENAI_API_KEY",
    upstream: "https://api.openai.com",
    authHeader: "authorization",
    baseUrlEnv: CODEX_BASE_URL_ENV,
    basePath: "/v1",
    directIfSet: [],
    accountMode: "chatgpt",
  },
  gemini: {
    keyEnv: "GEMINI_API_KEY",
    upstream: "https://generativelanguage.googleapis.com",
    authHeader: "x-goog-api-key",
    baseUrlEnv: "GOOGLE_GEMINI_BASE_URL",
    basePath: "",
    directIfSet: ["GOOGLE_GEMINI_BASE_URL"],
    accountMode: "google_account",
  },
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    upstream: "https://api.deepseek.com",
    authHeader: "authorization",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    basePath: "",
    directIfSet: ["DEEPSEEK_BASE_URL"],
  },
};

/** The broker does not speak to forward proxies, so an agent that must use one keeps its key. */
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface Grant {
  readonly provider: BrokeredProvider;
  readonly upstream: URL;
  readonly key: string;
  /** Open client sides of this agent's requests, cut when the agent goes away. */
  readonly live: Set<{ destroy(): unknown }>;
}

export interface BrokeredEnv {
  /** The env to spawn the agent with. */
  readonly env: Record<string, string>;
  /** Ends the agent's access. Idempotent. */
  revoke(): void;
  /** Set when the agent keeps its real key: the name of the env variable that prevents brokering. */
  readonly leftDirectBecause?: string;
}

export interface CredentialBrokerOptions {
  readonly log: Logger;
  /** Adapter id → upstream origin, replacing the fixed one. Tests only. */
  readonly upstreams?: Readonly<Record<string, string>>;
}

const noop = () => undefined;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

function presentedToken(header: AuthHeader, value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  if (header !== "authorization") return value.trim();
  const match = /^bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

/** The request target as an absolute path; anything else (`http://host/`, `*`, `//host/`) is refused. */
function isOriginForm(url: string | undefined): url is string {
  return url !== undefined && url.startsWith("/") && !url.startsWith("//");
}

/** Hop-by-hop names, including the ones `Connection` lists. */
function hopByHopNames(connection: string | string[] | undefined): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const name of [connection].flat().join(",").split(",")) names.add(name.trim().toLowerCase());
  return names;
}

function upstreamRequestHeaders(req: IncomingMessage, grant: Grant, upgrade: boolean): OutgoingHttpHeaders {
  const dropped = hopByHopNames(req.headers.connection);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (dropped.has(name) || name === "host" || name === "expect" || AUTH_HEADERS.includes(name as AuthHeader))
      continue;
    if (value !== undefined) headers[name] = value;
  }
  headers[grant.provider.authHeader] =
    grant.provider.authHeader === "authorization" ? `Bearer ${grant.key}` : grant.key;
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

/** `rawHeaders` minus hop-by-hop headers: repeats (`set-cookie`) and casing survive. */
function clientResponseHeaders(upstream: IncomingMessage): string[] {
  const dropped = hopByHopNames(upstream.headers.connection);
  const raw = upstream.rawHeaders;
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!dropped.has(raw[i]!.toLowerCase())) kept.push(raw[i]!, raw[i + 1]!);
  }
  return kept;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawResponseHead(
  status: number | undefined,
  reason: string | undefined,
  rawHeaders: readonly string[]
): string {
  let head = `HTTP/1.1 ${status ?? 502} ${reason ?? ""}\r\n`;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  return `${head}\r\n`;
}

/**
 * Keeps provider API keys out of everything that runs as an agent uid. For each agent the real key
 * stays in this process; the agent gets an opaque token and the URL of this loopback proxy, which
 * swaps the token for the key and forwards to the vendor's own host. The agents share the loopback
 * interface, so the token alone says whose key a request uses.
 *
 * Requests and responses are streamed. Nothing about them is logged except upstream failures, by
 * error code.
 */
export class CredentialBroker {
  readonly #log: Logger;
  readonly #upstreams: Readonly<Record<string, string>>;
  readonly #server: Server;
  readonly #grants = new Map<string, Grant>();
  #origin = "";

  constructor(options: CredentialBrokerOptions) {
    this.#log = options.log;
    this.#upstreams = options.upstreams ?? {};
    this.#server = createServer((req, res) => this.#onRequest(req, res));
    this.#server.keepAliveTimeout = KEEP_ALIVE_MS;
    this.#server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.#onUpgrade(req, socket, head)
    );
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, BROKER_HOST, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    this.#origin = `http://${BROKER_HOST}:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const grant of this.#grants.values()) for (const conn of grant.live) conn.destroy();
    this.#grants.clear();
    this.#server.closeAllConnections();
    if (this.#server.listening) await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Decide how the agent signs in to its provider and take the key out of `env` when it is brokered. */
  broker(adapter: string, env: Record<string, string>): BrokeredEnv {
    const provider = BROKERED_PROVIDERS[adapter];
    const key = provider ? env[provider.keyEnv]?.trim() : undefined;
    if (!provider || !key) return { env, revoke: noop };

    // Nothing reads the key in an account sign-in, so it does not need to be there at all.
    if (provider.accountMode && env[AGENT_AUTH_ENV]?.trim() === provider.accountMode) {
      const { [provider.keyEnv]: _key, ...rest } = env;
      return { env: rest, revoke: noop };
    }
    const blocker = [...provider.directIfSet, ...PROXY_ENV].find((name) => env[name]?.trim());
    if (blocker) return { env, revoke: noop, leftDirectBecause: blocker };

    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
    const id = digest(token);
    const grant: Grant = {
      provider,
      upstream: new URL(this.#upstreams[adapter] ?? provider.upstream),
      key,
      live: new Set(),
    };
    this.#grants.set(id, grant);
    return {
      env: {
        ...env,
        ...provider.extraEnv,
        [provider.keyEnv]: token,
        [provider.baseUrlEnv]: `${this.#origin}${provider.basePath}`,
      },
      revoke: () => {
        if (!this.#grants.delete(id)) return;
        for (const conn of grant.live) conn.destroy();
      },
    };
  }

  /** The grant a request's own auth header names, or `undefined`. */
  #authenticate(req: IncomingMessage): Grant | undefined {
    for (const header of AUTH_HEADERS) {
      const token = presentedToken(header, req.headers[header]);
      const grant = token === undefined ? undefined : this.#grants.get(digest(token));
      if (grant?.provider.authHeader === header) return grant;
    }
    return undefined;
  }

  /** The request to the provider. The connection's target comes only from the grant. */
  #open(grant: Grant, req: IncomingMessage, path: string, upgrade: boolean): ClientRequest {
    const { protocol, hostname, port } = grant.upstream;
    const send = protocol === "https:" ? httpsRequest : httpRequest;
    return send({
      protocol,
      hostname,
      ...(port ? { port } : {}),
      method: req.method,
      path,
      headers: upstreamRequestHeaders(req, grant, upgrade),
    });
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    const grant = this.#authenticate(req);
    if (!grant) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error", message: "Unknown credential" } }));
      return;
    }
    if (!isOriginForm(req.url)) {
      res.writeHead(400).end();
      return;
    }

    let upstream: ClientRequest;
    try {
      upstream = this.#open(grant, req, req.url, false);
    } catch (error) {
      this.#logFailure(grant, error);
      res.writeHead(502).end();
      return;
    }
    grant.live.add(res);
    res.on("error", noop);
    res.once("close", () => {
      grant.live.delete(res);
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.once("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, clientResponseHeaders(upstreamRes));
      // A stream can stay silent for a while after its headers; the client should see them now.
      res.flushHeaders();
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    });
    upstream.on("error", (error) => {
      this.#logFailure(grant, error);
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: "The provider could not be reached" } }));
      }
    });
    req.pipe(upstream);
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", noop);
    const grant = this.#authenticate(req);
    if (!grant) return refuse(socket, 401, "Unauthorized");
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !isOriginForm(req.url)) {
      return refuse(socket, 400, "Bad Request");
    }

    let upstream: ClientRequest;
    try {
      upstream = this.#open(grant, req, req.url, true);
    } catch (error) {
      this.#logFailure(grant, error);
      return refuse(socket, 502, "Bad Gateway");
    }
    grant.live.add(socket);
    socket.once("close", () => {
      grant.live.delete(socket);
      upstream.destroy();
    });
    upstream.once("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      grant.live.add(upstreamSocket);
      upstreamSocket.on("error", noop);
      socket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => {
        grant.live.delete(upstreamSocket);
        socket.destroy();
      });
      socket.write(rawResponseHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.rawHeaders));
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    // The provider refused the upgrade: hand its answer to the client.
    upstream.once("response", (upstreamRes) => {
      socket.write(
        rawResponseHead(upstreamRes.statusCode, upstreamRes.statusMessage, clientResponseHeaders(upstreamRes))
      );
      upstreamRes.pipe(socket);
      upstreamRes.on("error", () => socket.destroy());
    });
    upstream.on("error", (error) => {
      this.#logFailure(grant, error);
      if (socket.writable) refuse(socket, 502, "Bad Gateway");
      else socket.destroy();
    });
    upstream.end();
  }

  #logFailure(grant: Grant, error: unknown): void {
    this.#log.warn("agent-runner: credential broker could not reach the provider", {
      upstream: grant.upstream.host,
      code: (error as NodeJS.ErrnoException).code,
    });
  }
}
