/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import express, { type Express } from "express";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { GatewayConfig } from "./config.ts";
import { createLogger, withMeta, type Logger } from "./logger.ts";
import { originAllowed } from "./origin.ts";
import { createPlaneApi, PlaneApiError, type PlaneApi } from "./plane-api.ts";
import { CloseCode, encode, type ServerMessage } from "./protocol.ts";

const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
/** How long shutdown waits for sockets to close before cutting them. */
const SHUTDOWN_DEADLINE_MS = 5_000;

export interface ChatGatewayOptions {
  readonly config: GatewayConfig;
  readonly api?: PlaneApi;
  readonly log?: Logger;
}

type Refusal = { readonly ok: false; readonly code: number; readonly reason: string };
type Admission = {
  readonly ok: true;
  readonly userId: string;
  readonly workspace: { readonly id: string; readonly slug: string };
  /** The browser's session cookie, kept to re-check access with. Never logged or sent anywhere but the API. */
  readonly cookie: string;
  readonly release: () => void;
};

/** One admitted browser socket. */
interface Session {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly workspace: { readonly id: string; readonly slug: string };
  readonly cookie: string;
  readonly log: Logger;
}

/**
 * The chat gateway: `GET <base>/ws?workspace=<slug>` upgrades to a WebSocket that pushes Nexus Messages events
 * to one signed-in browser, after authenticating its session cookie with the Plane API;
 * `GET <base>/health` reports liveness. The gateway never writes data: every change goes through the REST API.
 */
export class ChatGateway {
  readonly app: Express;
  readonly server: HttpServer;
  readonly #config: GatewayConfig;
  readonly #api: PlaneApi;
  readonly #log: Logger;
  readonly #wss: WebSocketServer;
  readonly #sessions = new Set<Session>();
  readonly #perUser = new Map<string, number>();
  /** Upgrades still being authenticated. */
  readonly #admitting = new Set<Duplex>();
  #shuttingDown = false;
  /** Set while shutting down: called once the last socket has closed. */
  #onDrained: (() => void) | undefined;

  constructor(options: ChatGatewayOptions) {
    const { config } = options;
    this.#config = config;
    this.#log = options.log ?? createLogger("chat-gateway");
    this.#api = options.api ?? createPlaneApi({ baseUrl: config.apiBaseUrl });
    // A variable because `closeTimeout` is newer than `@types/ws`, which would reject it in an object literal.
    const socketOptions = {
      noServer: true,
      maxPayload: config.maxMessageBytes,
      perMessageDeflate: false,
      closeTimeout: config.closeTimeoutMs,
    };
    this.#wss = new WebSocketServer(socketOptions);

    this.app = express();
    this.app.disable("x-powered-by");
    this.app.get(`${config.basePath}/health`, (_req, res) => {
      res.status(this.#shuttingDown ? 503 : 200).json({
        status: this.#shuttingDown ? "SHUTTING_DOWN" : "OK",
        version: config.version,
        connections: this.#sessions.size,
        timestamp: new Date().toISOString(),
      });
    });
    this.app.use((_req, res) => {
      res.status(404).json({ message: "Not Found" });
    });

    this.server = createServer(this.app);
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#handleUpgrade(req, socket, head).catch((error: unknown) => {
        this.#log.error("chat-gateway: upgrade failed", { error: (error as Error).message });
        rejectHttp(socket, 500, "Internal Server Error");
      });
    });
  }

  get connectionCount(): number {
    return this.#sessions.size;
  }

  async listen(port = this.#config.port, host = this.#config.host): Promise<AddressInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    this.#log.info("chat-gateway: listening", { port: address.port, basePath: this.#config.basePath });
    return address;
  }

  /** Stop accepting connections, close the open ones, then stop. */
  async close(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    const httpClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const socket of this.#admitting) socket.destroy();
    for (const session of this.#sessions) session.socket.close(CloseCode.goingAway, "Server shutting down");
    const drained = new Promise<void>((resolve) => {
      if (this.#sessions.size === 0) resolve();
      else this.#onDrained = resolve;
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, SHUTDOWN_DEADLINE_MS);
    });
    await Promise.race([drained, timedOut]);
    clearTimeout(deadline);
    for (const client of this.#wss.clients) client.terminate();
    this.server.closeAllConnections();
    await httpClosed;
    this.#log.info("chat-gateway: stopped");
  }

  async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://gateway.invalid");
    } catch {
      return rejectHttp(socket, 400, "Bad Request");
    }
    if (url.pathname !== `${this.#config.basePath}/ws`) return rejectHttp(socket, 404, "Not Found");
    if (this.#shuttingDown) return rejectHttp(socket, 503, "Service Unavailable");
    if (!originAllowed(req, this.#config.allowedOrigins)) {
      this.#log.warn("chat-gateway: refused cross-origin upgrade", { origin: req.headers.origin });
      return rejectHttp(socket, 403, "Forbidden");
    }

    // Abort the admission work if the browser gives up while we authenticate. `end` as well as `close`: the HTTP
    // server keeps sockets half-open, so a clean hang-up never reaches `close`. `resume()` because Node leaves an
    // upgraded socket unread until `ws` takes it over, and anything unread would hide the hang-up behind it.
    const abort = new AbortController();
    const onGone = () => abort.abort();
    socket.once("end", onGone);
    socket.once("close", onGone);
    socket.resume();
    this.#admitting.add(socket);
    let admission: Admission | Refusal;
    try {
      admission = await this.#admit(req, url, abort.signal);
    } finally {
      this.#admitting.delete(socket);
      socket.off("end", onGone);
      socket.off("close", onGone);
    }

    // The connection slot lasts exactly as long as the socket, however it ends (`ws` never calls back for a
    // socket that died before the handshake finished).
    if (admission.ok) {
      if (socket.destroyed) admission.release();
      else socket.once("close", admission.release);
    }
    if (abort.signal.aborted || socket.destroyed || this.#shuttingDown) {
      if (admission.ok) admission.release();
      socket.destroy();
      return;
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      // Before anything else: an `error` event with no listener is thrown, which would end the whole process.
      ws.on("error", () => undefined);
      if (!admission.ok) {
        ws.close(admission.code, admission.reason);
        return;
      }
      this.#startSession(ws, admission);
    });
  }

  /**
   * Who is this, and may they be in this workspace? Both questions go to the API with the user's own cookie,
   * so Django decides exactly as it does for the web app.
   */
  async #admit(req: IncomingMessage, url: URL, signal: AbortSignal): Promise<Admission | Refusal> {
    const slug = url.searchParams.get("workspace") ?? "";
    if (!SLUG.test(slug)) return refuse(CloseCode.badRequest, "The workspace query parameter is required");
    const cookie = req.headers.cookie;
    if (!cookie) return refuse(CloseCode.unauthenticated, "Not signed in");
    // Before asking the API, so a full gateway or a flood of upgrades can't become a flood of API calls. Every
    // upgrade still being authenticated counts, so there is no need to look again once the API has answered.
    if (this.#sessions.size + this.#admitting.size > this.#config.maxConnections) {
      return refuse(CloseCode.tooManyRequests, "The chat service is at capacity");
    }

    const [user, workspace] = await Promise.allSettled([
      this.#api.currentUser(cookie, signal),
      this.#api.workspace(cookie, slug, signal),
    ]);
    // The browser left, or the gateway is stopping: the failed calls say nothing about the API, and no one is listening.
    if (signal.aborted) return refuse(CloseCode.goingAway, "Connection abandoned");
    // Check the user first: an anonymous request is refused by every endpoint, and that says nothing about the workspace.
    if (user.status === "rejected") {
      const status = user.reason instanceof PlaneApiError ? user.reason.status : 0;
      if (user.reason instanceof PlaneApiError && user.reason.isUnauthenticated) {
        return refuse(CloseCode.unauthenticated, "Not signed in");
      }
      this.#log.error("chat-gateway: could not authenticate", { status, error: (user.reason as Error).message });
      return refuse(CloseCode.internalError, "Authentication is unavailable");
    }
    if (workspace.status === "rejected") {
      const status = workspace.reason instanceof PlaneApiError ? workspace.reason.status : 0;
      if (status === 401 || status === 403 || status === 404) {
        return refuse(CloseCode.forbidden, "Not a member of this workspace");
      }
      this.#log.error("chat-gateway: could not check the workspace", {
        status,
        error: (workspace.reason as Error).message,
      });
      return refuse(CloseCode.internalError, "Authentication is unavailable");
    }

    const userId = user.value.id;
    const held = this.#perUser.get(userId) ?? 0;
    if (held >= this.#config.maxConnectionsPerUser) {
      return refuse(CloseCode.tooManyRequests, "Too many open chat connections");
    }
    this.#perUser.set(userId, held + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.#perUser.get(userId) ?? 1) - 1;
      if (count > 0) this.#perUser.set(userId, count);
      else this.#perUser.delete(userId);
    };
    return { ok: true, userId, workspace: { id: workspace.value.id, slug }, cookie, release };
  }

  #startSession(ws: WebSocket, admission: Admission): void {
    const log = withMeta(this.#log, {
      userId: admission.userId,
      workspaceId: admission.workspace.id,
      workspaceSlug: admission.workspace.slug,
    });
    const session: Session = {
      socket: ws,
      userId: admission.userId,
      workspace: admission.workspace,
      cookie: admission.cookie,
      log,
    };
    this.#sessions.add(session);
    const openedAt = Date.now();
    ws.once("close", (code) => {
      this.#sessions.delete(session);
      if (this.#sessions.size === 0) this.#onDrained?.();
      log.info("chat-gateway: socket closed", { code, durationMs: Date.now() - openedAt });
    });
    ws.on("message", (data, isBinary) => this.#onFrame(session, data, isBinary));
    // `ws` answers a ping by itself, so one sent without reading the answer never reaches `#send`.
    ws.on("ping", () => this.#closedForNotReading(ws));

    this.#keepAlive(ws);
    this.#send(ws, { type: "ready", user_id: session.userId, workspace_id: session.workspace.id });
    log.info("chat-gateway: socket opened");
  }

  #onFrame(session: Session, data: RawData, isBinary: boolean): void {
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(String(data));
    } catch {
      this.#send(session.socket, { type: "error", code: "bad_request", message: "Send JSON text frames" });
      return;
    }
    if (typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "ping") {
      this.#send(session.socket, { type: "pong" });
      return;
    }
    this.#send(session.socket, { type: "error", code: "bad_request", message: "Unknown message" });
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN && !this.#closedForNotReading(ws)) ws.send(encode(message));
  }

  /** A browser that has stopped reading would otherwise have everything sent to it held in memory, without limit. */
  #closedForNotReading(ws: WebSocket): boolean {
    if (ws.bufferedAmount <= this.#config.maxBufferedBytes) return false;
    ws.close(CloseCode.tryAgainLater, "Not keeping up");
    return true;
  }

  /** Ping the browser; a peer that misses a whole interval is gone. */
  #keepAlive(ws: WebSocket): void {
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const timer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.#config.pingIntervalMs);
    timer.unref();
    ws.once("close", () => clearInterval(timer));
  }
}

function refuse(code: number, reason: string): Refusal {
  return { ok: false, code, reason };
}

function rejectHttp(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  // Destroy once written: the HTTP server keeps sockets half-open, so `end()` alone would wait on the client for good.
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}
