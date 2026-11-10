/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { clampPermissionLevel, type PermissionLevel } from "@plane/agent-runner-protocol";
import express, { type Express } from "express";
import { WebSocketServer, type WebSocket } from "ws";

import { driveChannelSession, type ChannelSessionError, type ChannelSessionOutcome } from "./channel-session.ts";
import type { BridgeConfig } from "./config.ts";
import { DmSessions, type DmTurnRequest, type OpenedDmAgent } from "./dm-session.ts";
import { connectionsRouter } from "./connections.ts";
import {
  CHANNEL_MAX_PERMISSION_LEVEL,
  INTERNAL_PATH,
  internalRouter,
  type ChannelSessionAdmission,
  type ChannelSessionRequest,
} from "./internal.ts";
import { createLogger, withMeta, type Logger } from "./logger.ts";
import { sweepEndedMemberships } from "./offboarding.ts";
import { originAllowed } from "./origin.ts";
import { createPlaneApi, PlaneApiError, type AgentSessionGrant, type MemberRef, type PlaneApi } from "./plane-api.ts";
import { SessionPolicy } from "./policy.ts";
import { CloseCode, PolicyProxy } from "./proxy.ts";
import { RunnerLoginClient, type LoginRunner, type MemberRunner } from "./runner-login.ts";
import { RunnerTransport, type AgentChannel, type AgentTransport } from "./transport.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
/** How long shutdown waits for open connections to revoke their tokens. */
const SHUTDOWN_DEADLINE_MS = 10_000;

export interface AgentBridgeOptions {
  readonly config: BridgeConfig;
  readonly api?: PlaneApi;
  readonly transport?: AgentTransport;
  /** The runner's sign-in endpoints; defaults to HTTP at `config.runnerHttpUrl`. */
  readonly loginRunner?: LoginRunner;
  /** The runner's member endpoints; defaults to HTTP at `config.runnerHttpUrl`. */
  readonly memberRunner?: MemberRunner;
  readonly log?: Logger;
  /** How long a new connection has to send `initialize` (default 30 s). */
  readonly initializeTimeoutMs?: number;
  /** Agent DM drafts: least time between two posts, and new text posted at once (defaults 500 ms, 2048). */
  readonly dmDraftIntervalMs?: number;
  readonly dmDraftChars?: number;
}

type Refusal = { readonly ok: false; readonly code: number; readonly reason: string };
type Admission = {
  readonly ok: true;
  readonly grant: AgentSessionGrant;
  readonly channel: AgentChannel;
  readonly release: () => void;
};

interface LiveSession {
  readonly member: MemberRef;
  readonly socket: WebSocket;
  readonly proxy: PolicyProxy;
  readonly finished: Promise<void>;
}

/** A headless session for a mention in Nexus Messages. */
interface ChannelRun {
  readonly abort: AbortController;
  readonly finished: Promise<void>;
}

/** What a refusal while opening an agent means for a channel session. */
const CHANNEL_ERRORS: Partial<Record<number, ChannelSessionError>> = {
  [CloseCode.tooManyConnections]: "busy",
  [CloseCode.agentUnavailable]: "unavailable",
  [CloseCode.internalError]: "unavailable",
};

/**
 * The agent bridge: `GET <base>/acp?agent=<id>&workspace=<slug>` upgrades to an ACP WebSocket for
 * one chat, after authenticating the browser's cookie with the API and minting an agent-session
 * token; `<base>/connections/<provider>/…` drives provider account sign-in; `GET <base>/health`
 * reports liveness.
 */
export class AgentBridge {
  readonly app: Express;
  readonly server: HttpServer;
  readonly #config: BridgeConfig;
  readonly #api: PlaneApi;
  readonly #transport: AgentTransport;
  readonly #log: Logger;
  readonly #wss: WebSocketServer;
  readonly #acp: AcpServer;
  readonly #sessions = new Set<LiveSession>();
  readonly #channelRuns = new Set<ChannelRun>();
  readonly #dm: DmSessions;
  readonly #perUser = new Map<string, number>();
  readonly #initializeTimeoutMs: number;
  readonly #memberRunner: MemberRunner;
  #pendingAdmissions = 0;
  #shuttingDown = false;
  #sweep: Promise<MemberRef[]> | undefined;
  #sweepTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #sweepAbort = new AbortController();

  constructor(options: AgentBridgeOptions) {
    const { config } = options;
    this.#config = config;
    this.#log = options.log ?? createLogger("agent-bridge");
    this.#initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000;
    this.#api = options.api ?? createPlaneApi({ baseUrl: config.apiBaseUrl, bridgeSecret: config.bridgeSecret });
    this.#transport =
      options.transport ??
      new RunnerTransport({
        url: config.runnerUrl,
        secret: config.runnerSecret,
        maxMessageBytes: config.maxAgentMessageBytes,
      });
    // The SDK's AcpServer frames ACP over each accepted socket (initialize-first, no batches,
    // backpressure); the PolicyProxy is the "agent" it connects to.
    this.#acp = new AcpServer({
      createAgent: () => {
        throw new Error("every connection supplies its own proxy");
      },
      maxBufferedBytes: Math.max(64 * 1024 * 1024, config.maxMessageBytes * 4),
    });
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false });
    const runnerClient = new RunnerLoginClient({ baseUrl: config.runnerHttpUrl, secret: config.runnerSecret });
    this.#memberRunner = options.memberRunner ?? runnerClient;
    this.#dm = new DmSessions({
      reporter: this.#api,
      reserve: (userId) => {
        const slot = this.#reserve(userId, 0);
        return slot.ok ? slot : { ok: false };
      },
      openAgent: (request, signal) => this.#openDmAgent(request, signal),
      log: this.#log,
      idleTimeoutMs: config.dmIdleTimeoutMs,
      clientVersion: config.version,
      ...(options.dmDraftIntervalMs !== undefined ? { draftIntervalMs: options.dmDraftIntervalMs } : {}),
      ...(options.dmDraftChars !== undefined ? { draftChars: options.dmDraftChars } : {}),
    });

    this.app = express();
    this.app.disable("x-powered-by");
    this.app.get(`${config.basePath}/health`, (_req, res) => {
      res.status(this.#shuttingDown ? 503 : 200).json({
        status: this.#shuttingDown ? "SHUTTING_DOWN" : "OK",
        version: config.version,
        connections: this.#sessions.size,
        channelSessions: this.#channelRuns.size,
        dmSessions: this.#dm.heldCount,
        timestamp: new Date().toISOString(),
      });
    });
    this.app.use(
      `${config.basePath}/connections`,
      connectionsRouter({
        api: this.#api,
        runner: options.loginRunner ?? runnerClient,
        log: this.#log,
        allowedOrigins: config.allowedOrigins,
        startLimit: { max: config.loginStartLimit, windowMs: config.loginStartWindowMs },
      })
    );
    // Outside the base path: the reverse proxy forwards only the base path, so this stays internal.
    this.app.use(
      INTERNAL_PATH,
      internalRouter({
        secret: config.bridgeSecret,
        startChannelSession: (request) => this.#startChannelRun(request),
        startDmTurn: (request) => (this.#shuttingDown ? "shutting_down" : this.#dm.start(request)),
        answerDmPermission: (channelId, runId, requestId, optionId) =>
          this.#dm.answerPermission(channelId, runId, requestId, optionId),
        cancelDmTurn: (channelId, runId) => this.#dm.cancel(channelId, runId),
        log: this.#log,
      })
    );
    this.app.use((_req, res) => {
      res.status(404).json({ message: "Not Found" });
    });

    this.server = createServer(this.app);
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#handleUpgrade(req, socket, head).catch((error: unknown) => {
        this.#log.error("agent-bridge: upgrade failed", { error: (error as Error).message });
        rejectHttp(socket, 500, "Internal Server Error");
      });
    });
  }

  get connectionCount(): number {
    return this.#sessions.size;
  }

  /** Headless sessions for mentions in Nexus Messages still running. */
  get channelSessionCount(): number {
    return this.#channelRuns.size;
  }

  /** Agent DM sessions held open between turns. */
  get dmSessionCount(): number {
    return this.#dm.heldCount;
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
    this.#log.info("agent-bridge: listening", { port: address.port, basePath: this.#config.basePath });
    this.#scheduleSweep();
    return address;
  }

  /**
   * Offboard members whose workspace membership has ended: close their chats and have the runner
   * delete their agent state (see `sweepEndedMemberships`). Runs every `offboardIntervalMs`; a call
   * while a pass is running joins it. Resolves with the members offboarded.
   */
  sweepEndedMemberships(): Promise<MemberRef[]> {
    this.#sweep ??= sweepEndedMemberships({
      api: this.#api,
      runner: this.#memberRunner,
      liveMembers: () => [...this.#sessions].map((session) => session.member),
      closeChats: (member) => this.#closeChats(member),
      log: this.#log,
      maxPerPass: this.#config.offboardMaxPerPass,
      signal: this.#sweepAbort.signal,
    }).finally(() => {
      this.#sweep = undefined;
    });
    return this.#sweep;
  }

  #scheduleSweep(): void {
    if (this.#shuttingDown) return;
    this.#sweepTimer = setTimeout(() => {
      void this.sweepEndedMemberships().finally(() => this.#scheduleSweep());
    }, this.#config.offboardIntervalMs);
    this.#sweepTimer.unref();
  }

  async #closeChats(member: MemberRef): Promise<void> {
    const sessions = [...this.#sessions].filter(
      (session) => session.member.workspaceId === member.workspaceId && session.member.userId === member.userId
    );
    for (const session of sessions) session.socket.close(CloseCode.forbidden, "Workspace membership ended");
    await Promise.all(sessions.map((session) => session.finished));
  }

  /** Stop accepting connections, close the open ones (which revokes their tokens), then stop. */
  async close(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    clearTimeout(this.#sweepTimer);
    this.#sweepAbort.abort();
    const httpClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const session of this.#sessions) session.socket.close(CloseCode.goingAway, "Server shutting down");
    // A channel session that is stopped tells the API, which posts a note in its thread.
    for (const run of this.#channelRuns) run.abort.abort();
    const drained = Promise.all([
      ...[...this.#sessions].map((session) => session.finished),
      ...[...this.#channelRuns].map((run) => run.finished),
      // Running DM turns tell the API they were stopped; held sessions close and revoke their tokens.
      this.#dm.close(),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drained,
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    await this.#acp.close();
    for (const client of this.#wss.clients) client.terminate();
    this.server.closeAllConnections();
    await httpClosed;
    this.#log.info("agent-bridge: stopped");
  }

  async #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => undefined);
    const url = new URL(req.url ?? "/", "http://bridge.invalid");
    if (url.pathname !== `${this.#config.basePath}/acp`) return rejectHttp(socket, 404, "Not Found");
    if (this.#shuttingDown) return rejectHttp(socket, 503, "Service Unavailable");
    if (!originAllowed(req, this.#config.allowedOrigins)) {
      this.#log.warn("agent-bridge: refused cross-origin upgrade", { origin: req.headers.origin });
      return rejectHttp(socket, 403, "Forbidden");
    }

    // Abort the admission work if the browser gives up while we authenticate.
    const abort = new AbortController();
    const onGone = () => abort.abort();
    socket.once("close", onGone);
    this.#pendingAdmissions += 1;
    let admission: Admission | Refusal;
    try {
      admission = await this.#admit(req, url, abort.signal);
    } finally {
      this.#pendingAdmissions -= 1;
      socket.off("close", onGone);
    }

    if (abort.signal.aborted || socket.destroyed || this.#shuttingDown) {
      if (admission.ok) this.#discard(admission, "browser left during admission");
      socket.destroy();
      return;
    }

    // `ws` answers a handshake it rejects by itself and never runs the callback, and the admission
    // would then be held for good. The callback runs synchronously, before the socket can close.
    const abandon = () => {
      if (admission.ok) this.#discard(admission, "websocket handshake failed");
    };
    socket.once("close", abandon);
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", abandon);
      // `ws` reports a bad frame as an `error` event, which ends the process if nothing listens. This
      // listener has to stay for the socket's whole life: the SDK drops its own when a session closes.
      ws.on("error", (error) => this.#log.warn("agent-bridge: websocket error", { error: error.message }));
      if (!admission.ok) {
        ws.close(admission.code, admission.reason);
        return;
      }
      this.#startSession(ws, admission);
    });
  }

  async #admit(req: IncomingMessage, url: URL, signal: AbortSignal): Promise<Admission | Refusal> {
    const agentId = url.searchParams.get("agent") ?? "";
    const workspaceSlug = url.searchParams.get("workspace") ?? "";
    if (!UUID.test(agentId) || !SLUG.test(workspaceSlug)) {
      return refuse(CloseCode.badRequest, "agent and workspace query parameters are required");
    }
    const cookie = req.headers.cookie;
    if (!cookie) return refuse(CloseCode.unauthenticated, "Not signed in");

    let userId: string;
    try {
      userId = (await this.#api.currentUser(cookie, signal)).id;
    } catch (error) {
      const status = error instanceof PlaneApiError ? error.status : 0;
      if (status === 401 || status === 403) return refuse(CloseCode.unauthenticated, "Not signed in");
      this.#log.error("agent-bridge: could not authenticate", { status, error: (error as Error).message });
      return refuse(CloseCode.internalError, "Authentication is unavailable");
    }

    // This admission is one of those under way.
    const slot = this.#reserve(userId, 1);
    if (!slot.ok) return slot;
    const admission = await this.#openAgent({ userId, workspaceSlug, agentId }, signal);
    if (!admission.ok) {
      slot.release();
      return admission;
    }
    return { ...admission, release: slot.release };
  }

  /**
   * Count a session against the caps: the bridge's (browser sockets, admissions under way and
   * channel sessions together) and the user's. `pending` is how many of the admissions under way
   * are this one.
   */
  #reserve(userId: string, pending: number): { ok: true; release: () => void } | Refusal {
    const open = this.#sessions.size + this.#pendingAdmissions - pending + this.#channelRuns.size + this.#dm.slotCount;
    if (open >= this.#config.maxConnections) {
      return refuse(CloseCode.tooManyConnections, "The agent service is at capacity");
    }
    const held = this.#perUser.get(userId) ?? 0;
    if (held >= this.#config.maxConnectionsPerUser) {
      return refuse(CloseCode.tooManyConnections, "Too many open agent chats");
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
    return { ok: true, release };
  }

  /**
   * Mint the agent-session token for the user and open the agent on the runner. `level` (a channel
   * session's) replaces the registry default as the starting level, clamped to the maximum.
   * `maxLevel` lowers that maximum for this session, so the agent can't switch above it either.
   */
  async #openAgent(
    input: {
      userId: string;
      workspaceSlug: string;
      agentId: string;
      level?: PermissionLevel;
      maxLevel?: PermissionLevel;
    },
    signal: AbortSignal
  ): Promise<Omit<Admission, "release"> | Refusal> {
    const { userId, workspaceSlug, agentId } = input;
    let grant: AgentSessionGrant;
    try {
      grant = await this.#api.createAgentSession({ userId, workspaceSlug, agentId }, signal);
    } catch (error) {
      const status = error instanceof PlaneApiError ? error.status : 0;
      if (error instanceof PlaneApiError && error.isBridgeCredentialError) {
        this.#log.error("agent-bridge: the API rejected AGENT_BRIDGE_SECRET; check it matches the API's", { status });
        return refuse(CloseCode.internalError, "The agent service is misconfigured");
      }
      if (status === 400) return refuse(CloseCode.badRequest, "Invalid agent request");
      if (status === 403) return refuse(CloseCode.forbidden, "Not a member of this workspace");
      if (status === 404) return refuse(CloseCode.agentNotFound, "Agent not found or disabled");
      this.#log.error("agent-bridge: could not start an agent session", { status, error: (error as Error).message });
      return refuse(CloseCode.internalError, "Could not start the agent session");
    }
    if (input.maxLevel) {
      const maxPermissionLevel = clampPermissionLevel(grant.agent.maxPermissionLevel, input.maxLevel);
      grant = {
        ...grant,
        agent: {
          ...grant.agent,
          maxPermissionLevel,
          defaultPermissionLevel: clampPermissionLevel(grant.agent.defaultPermissionLevel, maxPermissionLevel),
        },
      };
    }
    if (input.level) {
      const start = clampPermissionLevel(input.level, grant.agent.maxPermissionLevel);
      grant = { ...grant, agent: { ...grant.agent, defaultPermissionLevel: start } };
    }

    const log = withMeta(this.#log, {
      sessionRef: grant.tokenId,
      userId,
      workspaceSlug,
      agentId,
      adapter: grant.agent.adapter,
    });
    let channel: AgentChannel;
    try {
      channel = await this.#transport.open(grant, signal);
    } catch (error) {
      void this.#revoke(grant, log);
      log.error("agent-bridge: agent runner unavailable", { error: (error as Error).message });
      return refuse(CloseCode.agentUnavailable, "The agent is unavailable");
    }
    return { ok: true, grant, channel };
  }

  #discard(admission: Admission, reason: string): void {
    admission.channel.close();
    admission.release();
    void this.#revoke(admission.grant, withMeta(this.#log, { sessionRef: admission.grant.tokenId }));
    this.#log.info("agent-bridge: admission discarded", { reason });
  }

  #policyFor(grant: AgentSessionGrant): SessionPolicy {
    const mcpUrl = this.#config.planeMcpUrl || grant.mcp.url;
    return new SessionPolicy({
      cwd: `${this.#config.workspacesRoot}/${grant.workspace.id}/${grant.user.id}`.replace(/^\/\//, "/"),
      defaultLevel: grant.agent.defaultPermissionLevel,
      maxLevel: grant.agent.maxPermissionLevel,
      attachPlaneMcp: grant.agent.attachPlaneMcp,
      planeMcp: mcpUrl
        ? { url: mcpUrl, token: grant.token, workspaceSlug: grant.mcp.workspaceSlug || grant.workspace.slug }
        : undefined,
    });
  }

  #grantLog(grant: AgentSessionGrant): Logger {
    return withMeta(this.#log, {
      sessionRef: grant.tokenId,
      userId: grant.user.id,
      workspaceSlug: grant.workspace.slug,
      agentId: grant.agent.id,
      adapter: grant.agent.adapter,
    });
  }

  /**
   * `POST /internal/channel-sessions`: take a session on for a mention in Nexus Messages, under the
   * same caps as browser sessions, and run it after answering. Its outcome goes to the API.
   */
  #startChannelRun(request: ChannelSessionRequest): ChannelSessionAdmission {
    if (this.#shuttingDown) return "shutting_down";
    const slot = this.#reserve(request.userId, 0);
    if (!slot.ok) {
      this.#log.warn("agent-bridge: refused a channel session", { reason: slot.reason, userId: request.userId });
      return "busy";
    }
    const abort = new AbortController();
    const finished = (async () => {
      let outcome: ChannelSessionOutcome;
      try {
        outcome = await this.#runChannelSession(request, abort.signal);
      } catch (error) {
        this.#log.error("agent-bridge: channel session crashed", { error: (error as Error).message });
        outcome = { status: "failed", error: "failed" };
      } finally {
        slot.release();
      }
      try {
        await this.#api.reportChannelReply(
          request.runId,
          outcome.status === "ok"
            ? { status: "ok", text: outcome.text, permissionRequests: outcome.permissionRequests }
            : { status: "failed", error: outcome.error }
        );
      } catch (error) {
        const status = error instanceof PlaneApiError ? error.status : 0;
        this.#log.warn("agent-bridge: the API did not take a channel reply", { runId: request.runId, status });
      }
    })();
    const run: ChannelRun = { abort, finished };
    this.#channelRuns.add(run);
    void finished.finally(() => this.#channelRuns.delete(run));
    return "accepted";
  }

  async #runChannelSession(request: ChannelSessionRequest, signal: AbortSignal): Promise<ChannelSessionOutcome> {
    const opened = await this.#openAgent(
      {
        userId: request.userId,
        workspaceSlug: request.workspaceSlug,
        agentId: request.agentId,
        level: request.permissionLevel,
        maxLevel: CHANNEL_MAX_PERMISSION_LEVEL,
      },
      signal
    );
    if (!opened.ok) return { status: "failed", error: CHANNEL_ERRORS[opened.code] ?? "failed" };
    const { grant, channel } = opened;
    const log = withMeta(this.#grantLog(grant), { runId: request.runId });
    const startedAt = Date.now();
    log.info("agent-bridge: channel session started");
    try {
      return await driveChannelSession({
        upstream: channel,
        policy: this.#policyFor(grant),
        level: grant.agent.defaultPermissionLevel,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        idleTimeoutMs: this.#config.idleTimeoutMs,
        expiresAt: grant.expiresAt,
        signal,
        log,
        clientVersion: this.#config.version,
      });
    } finally {
      channel.close();
      await this.#revoke(grant, log);
      log.info("agent-bridge: channel session ended", { durationMs: Date.now() - startedAt });
    }
  }

  /** Open the agent for an agent DM's held session, as the DM's person, at the DM's level. */
  async #openDmAgent(
    request: DmTurnRequest,
    signal: AbortSignal
  ): Promise<OpenedDmAgent | { ok: false; error: ChannelSessionError }> {
    const opened = await this.#openAgent(
      {
        userId: request.userId,
        workspaceSlug: request.workspaceSlug,
        agentId: request.agentId,
        level: request.permissionLevel,
      },
      signal
    );
    if (!opened.ok) return { ok: false, error: CHANNEL_ERRORS[opened.code] ?? "failed" };
    const { grant, channel } = opened;
    const log = withMeta(this.#grantLog(grant), { channelId: request.channelId });
    return {
      ok: true,
      grant,
      upstream: channel,
      policy: this.#policyFor(grant),
      log,
      revoke: () => this.#revoke(grant, log),
    };
  }

  #startSession(ws: WebSocket, admission: Admission): void {
    const { grant, channel, release } = admission;
    const log = this.#grantLog(grant);
    const policy = this.#policyFor(grant);
    const proxy = new PolicyProxy({
      policy,
      upstream: channel,
      log,
      idleTimeoutMs: this.#config.idleTimeoutMs,
      initializeTimeoutMs: this.#initializeTimeoutMs,
      expiresAt: grant.expiresAt,
      closeClient: (code, reason) => ws.close(code, reason),
    });

    const openedAt = Date.now();
    const finished = (async () => {
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
      proxy.close("client disconnected");
      release();
      await this.#revoke(grant, log);
      log.info("agent-bridge: session closed", {
        reason: proxy.closeReason,
        durationMs: Date.now() - openedAt,
      });
    })();
    const session: LiveSession = {
      member: { workspaceId: grant.workspace.id, userId: grant.user.id },
      socket: ws,
      proxy,
      finished,
    };
    this.#sessions.add(session);
    void finished.finally(() => this.#sessions.delete(session));
    // Once the agent side closes, make sure the browser socket follows.
    void (async () => {
      await proxy.closed;
      if (ws.readyState === ws.OPEN) ws.close(CloseCode.normal, "Session ended");
    })();

    this.#keepAlive(ws);
    this.#acp.prepareWebSocketUpgrade({ agent: proxy }).accept(ws);
    log.info("agent-bridge: session opened", { expiresAt: grant.expiresAt.toISOString() });
  }

  /** Ping the browser; a peer that misses a whole interval is gone. Pings are not activity. */
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

  async #revoke(grant: AgentSessionGrant, log: Logger): Promise<void> {
    try {
      await this.#api.revokeAgentSession(grant.tokenId);
      log.info("agent-bridge: agent-session token revoked");
    } catch (error) {
      log.error("agent-bridge: could not revoke the agent-session token (it still expires on its own)", {
        error: (error as Error).message,
      });
    }
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
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
