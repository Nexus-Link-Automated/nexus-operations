/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomBytes } from "node:crypto";

import {
  PROTOCOL_VERSION,
  client,
  type AnyMessage,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { INITIAL_MODE_META_KEY, clampPermissionLevel, type PermissionLevel } from "@plane/agent-runner-protocol";

import { MAX_REPLY_CHARS, type ChannelSessionError } from "./channel-session.ts";
import type { Logger } from "./logger.ts";
import type { AgentSessionGrant, MemberRef } from "./plane-api.ts";
import type { SessionPolicy } from "./policy.ts";
import { PolicyProxy } from "./proxy.ts";
import type { AgentChannel } from "./transport.ts";

/** A turn the API asks for when the person writes in an agent DM in Nexus Messages. */
export interface DmTurnRequest {
  readonly runId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly workspaceSlug: string;
  readonly agentId: string;
  readonly permissionLevel: PermissionLevel;
  /** Only the new message(s): for a session that is held, or loaded from `sessionRef`. */
  readonly prompt: string;
  /** Recent DM history and the new message(s): for a brand-new session. */
  readonly primer: string;
  /** The ACP session ID last reported for this DM. */
  readonly sessionRef: string | null;
  readonly timeoutMs: number;
}

export type DmTurnAdmission = "accepted" | "busy" | "conflict" | "shutting_down";

export type DmToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** A tool call the agent made during a turn, as the DM lists it: no input, no output. */
export interface DmToolCall {
  readonly id: string;
  readonly title: string;
  readonly status: DmToolCallStatus;
}

export interface DmPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type DmTurnOutcome =
  | {
      readonly status: "ok";
      readonly text: string;
      readonly toolCalls: readonly DmToolCall[];
      readonly sessionRef: string | null;
      readonly stopReason: string;
    }
  | {
      readonly status: "failed";
      readonly error: ChannelSessionError;
      readonly text: string;
      readonly toolCalls: readonly DmToolCall[];
      readonly sessionRef: string | null;
    };

/** What the API said to a draft or a permission prompt: taken, the run may no longer post (404/409), or no answer. */
export type DmPostResult = "ok" | "refused" | "error";

/** The API's side of a DM turn (`plane.chat` internal endpoints). */
export interface DmReporter {
  reportDmDraft(runId: string, draft: { text: string; toolCalls: readonly DmToolCall[] }): Promise<DmPostResult>;
  reportDmPermission(
    runId: string,
    request: { requestId: string; title: string; options: readonly DmPermissionOption[] }
  ): Promise<DmPostResult>;
  reportDmReply(runId: string, outcome: DmTurnOutcome): Promise<void>;
}

/** The agent opened on the runner for a DM, with what closing it takes. */
export interface OpenedDmAgent {
  readonly ok: true;
  readonly grant: AgentSessionGrant;
  readonly upstream: AgentChannel;
  readonly policy: SessionPolicy;
  readonly log: Logger;
  /** Revoke the agent-session token. */
  readonly revoke: () => Promise<void>;
}

export type DmSlot = { readonly ok: true; readonly release: () => void } | { readonly ok: false };

export interface DmSessionsOptions {
  readonly reporter: DmReporter;
  /** Take a per-user and a bridge-wide slot (shared with browser chats and channel sessions). */
  readonly reserve: (userId: string) => DmSlot;
  /** Mint the token for the DM's person and open the agent at the DM's level. */
  readonly openAgent: (
    request: DmTurnRequest,
    signal: AbortSignal
  ) => Promise<OpenedDmAgent | { readonly ok: false; readonly error: ChannelSessionError }>;
  readonly log: Logger;
  /** A held session with no turn for this long is closed. */
  readonly idleTimeoutMs: number;
  readonly clientVersion: string;
  /** Least time between two draft posts (default 500 ms). */
  readonly draftIntervalMs?: number;
  /** New text that is posted at once, whatever the interval (default 2048 characters). */
  readonly draftChars?: number;
}

const DEFAULT_DRAFT_INTERVAL_MS = 500;
const DEFAULT_DRAFT_CHARS = 2_048;
const MAX_TOOL_CALLS = 50;
const MAX_FIELD_CHARS = 200;
const MAX_PERMISSION_OPTIONS = 10;
/** ACP's "authentication required": the agent has no working provider credentials. */
const AUTH_REQUIRED = -32_000;
/** A held session is reused only if its token outlives the next turn by this much. */
const TOKEN_MARGIN_MS = 30_000;
const CLOSE_GRACE_MS = 100;
const TOOL_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "failed"]);
const OPTION_KINDS: ReadonlySet<string> = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

const clip = (value: unknown): string => (typeof value === "string" ? value.trim().slice(0, MAX_FIELD_CHARS) : "");

/**
 * Posts a turn's draft to the API while the agent writes: the first change at once, then at most once per
 * `intervalMs`, or at once when `chars` of new text have piled up. One post at a time; changes made during a post
 * go in the next one.
 */
export class DraftStreamer {
  readonly #send: () => Promise<void>;
  readonly #size: () => number;
  readonly #intervalMs: number;
  readonly #chars: number;
  #lastAt = 0;
  #sentSize = 0;
  #dirty = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(options: { send: () => Promise<void>; size: () => number; intervalMs: number; chars: number }) {
    this.#send = options.send;
    this.#size = options.size;
    this.#intervalMs = options.intervalMs;
    this.#chars = options.chars;
  }

  /** Something in the draft changed. */
  touch(): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#schedule();
  }

  /** No more posts; resolves once the one in flight (if any) is done. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  #schedule(): void {
    if (this.#stopped || this.#inFlight || !this.#dirty) return;
    const big = this.#size() - this.#sentSize >= this.#chars;
    const wait = big ? 0 : Math.max(0, this.#lastAt + this.#intervalMs - Date.now());
    if (wait === 0) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#flush();
      return;
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#schedule();
    }, wait);
  }

  #flush(): void {
    this.#dirty = false;
    this.#lastAt = Date.now();
    this.#sentSize = this.#size();
    this.#inFlight = this.#send()
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight = undefined;
        this.#schedule();
      });
  }
}

interface PendingPermission {
  readonly optionIds: ReadonlySet<string>;
  readonly settle: (response: RequestPermissionResponse) => void;
  readonly rejectOption: string | undefined;
}

/** What one turn has gathered, and how to stop it. */
class Turn {
  text = "";
  afterTool = false;
  readonly toolCalls = new Map<string, DmToolCall>();
  readonly permissions = new Map<string, PendingPermission>();
  cancelled = false;
  /** The API refused a draft or a prompt: the run may no longer post. */
  refused = false;
  ended = false;
  streamer: DraftStreamer | undefined;
  readonly runId: string;
  readonly #onRefused: () => void;

  constructor(runId: string, onRefused: () => void) {
    this.runId = runId;
    this.#onRefused = onRefused;
  }

  refuse(): void {
    if (this.refused) return;
    this.refused = true;
    this.#onRefused();
  }

  toolCallList(): DmToolCall[] {
    return [...this.toolCalls.values()];
  }

  /** Answer every prompt still waiting: with its reject option (`expire`), or `cancelled`. */
  settleAll(how: "expire" | "cancel"): void {
    for (const [id, pending] of this.permissions) {
      this.permissions.delete(id);
      pending.settle(
        how === "expire" && pending.rejectOption
          ? { outcome: { outcome: "selected", optionId: pending.rejectOption } }
          : { outcome: { outcome: "cancelled" } }
      );
    }
  }
}

/**
 * One agent DM's ACP session, held between turns. The bridge is the ACP client here, behind the same
 * `PolicyProxy` and `SessionPolicy` as a browser chat, so every rewrite and refusal applies. Unlike a channel
 * session, a permission prompt goes to the API, which asks the DM's person; the answer comes back through
 * `answerPermission`.
 */
export class HeldDmSession {
  readonly channelId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly grant: AgentSessionGrant;
  readonly #proxy: PolicyProxy;
  readonly #connection: ClientConnection;
  readonly #log: Logger;
  readonly #options: DmSessionsOptions;
  readonly #release: () => void;
  readonly #revoke: () => Promise<void>;
  readonly #onClosed: (session: HeldDmSession) => void;
  #initialized = false;
  #sessionId: string | undefined;
  #level: PermissionLevel | undefined;
  #loading = false;
  #turn: Turn | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #closedPromise: Promise<void> | undefined;

  constructor(input: {
    request: DmTurnRequest;
    opened: OpenedDmAgent;
    release: () => void;
    options: DmSessionsOptions;
    onClosed: (session: HeldDmSession) => void;
  }) {
    const { request, opened, options } = input;
    this.channelId = request.channelId;
    this.userId = request.userId;
    this.agentId = request.agentId;
    this.grant = opened.grant;
    this.#log = opened.log;
    this.#options = options;
    this.#release = input.release;
    this.#revoke = opened.revoke;
    this.#onClosed = input.onClosed;

    const toProxy = new TransformStream<AnyMessage, AnyMessage>();
    const toClient = new TransformStream<AnyMessage, AnyMessage>();
    this.#proxy = new PolicyProxy({
      policy: opened.policy,
      upstream: opened.upstream,
      log: this.#log,
      idleTimeoutMs: options.idleTimeoutMs,
      expiresAt: opened.grant.expiresAt,
      // The token expired or the proxy gave up: the session can't go on.
      closeClient: (_code, reason) => void this.close(reason),
    });
    this.#proxy.connect({ readable: toProxy.readable, writable: toClient.writable });
    void this.#proxy.closed.then(() => this.close("agent went away"));

    const app = client({ name: "plane-messages" })
      .onRequest("session/request_permission", ({ params }) => this.#onPermission(params))
      .onNotification("session/update", ({ params }) => this.#onUpdate(params as SessionNotification));
    this.#connection = app.connect({ readable: toClient.readable, writable: toProxy.writable });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get busy(): boolean {
    return this.#turn !== undefined;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** Whether the next turn of this DM can run here instead of in a new session. */
  reusableFor(request: DmTurnRequest): boolean {
    return (
      !this.#closed &&
      !this.busy &&
      this.userId === request.userId &&
      this.agentId === request.agentId &&
      this.grant.expiresAt.getTime() - Date.now() > request.timeoutMs + TOKEN_MARGIN_MS
    );
  }

  /** Answer a permission prompt of the running turn `runId` with one of its options. */
  answerPermission(runId: string, requestId: string, optionId: string): "answered" | "not_found" | "bad_option" {
    const turn = this.#turn;
    const pending = turn && turn.runId === runId ? turn.permissions.get(requestId) : undefined;
    if (!turn || !pending) return "not_found";
    if (!pending.optionIds.has(optionId)) return "bad_option";
    turn.permissions.delete(requestId);
    pending.settle({ outcome: { outcome: "selected", optionId } });
    this.#log.info("agent-bridge: a permission prompt in an agent DM was answered");
    return "answered";
  }

  /** Stop the running turn `runId` (`session/cancel`). False if it isn't the one running. */
  cancel(runId: string): boolean {
    const turn = this.#turn;
    if (!turn || turn.runId !== runId || turn.ended) return false;
    this.#cancelTurn(turn, "cancel");
    return true;
  }

  #cancelTurn(turn: Turn, how: "cancel" | "expire"): void {
    turn.cancelled = true;
    // ACP: once the client cancels, it answers every prompt still waiting with `cancelled`.
    turn.settleAll(how);
    if (this.#sessionId) {
      this.#connection.agent.notify("session/cancel", { sessionId: this.#sessionId }).catch(() => undefined);
    }
  }

  /** Close the session: the runner stops the agent, the token is revoked and the slot freed. Idempotent. */
  close(reason: string): Promise<void> {
    if (this.#closedPromise) return this.#closedPromise;
    this.#closed = true;
    clearTimeout(this.#idleTimer);
    if (this.#turn) this.#turn.settleAll("expire");
    this.#connection.close();
    this.#proxy.close(reason);
    this.#release();
    this.#log.info("agent-bridge: agent DM session closed", { reason });
    this.#closedPromise = this.#revoke();
    this.#onClosed(this);
    return this.#closedPromise;
  }

  /**
   * One turn: set the session up if this is its first (load `sessionRef`, else a new session primed with the DM's
   * history), then prompt. Ends with the agent's stop, the time limit, `signal` (shutdown) or the agent going away.
   */
  async runTurn(request: DmTurnRequest, signal: AbortSignal): Promise<DmTurnOutcome> {
    clearTimeout(this.#idleTimer);
    let onRefused!: () => void;
    const refused = new Promise<"refused">((resolve) => {
      onRefused = () => resolve("refused");
    });
    const turn = new Turn(request.runId, onRefused);
    this.#turn = turn;
    const streamer = new DraftStreamer({
      send: () => this.#postDraft(turn),
      size: () => turn.text.length,
      intervalMs: this.#options.draftIntervalMs ?? DEFAULT_DRAFT_INTERVAL_MS,
      chars: this.#options.draftChars ?? DEFAULT_DRAFT_CHARS,
    });
    turn.streamer = streamer;
    const level = clampPermissionLevel(request.permissionLevel, this.grant.agent.maxPermissionLevel);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), request.timeoutMs);
    });
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const gone = this.#proxy.closed.then(() => "gone" as const);
    const work = this.#work(turn, request, level);
    work.catch(() => undefined);

    let keep = false;
    const partial = () => ({ text: turn.text, toolCalls: turn.toolCallList(), sessionRef: this.#sessionId ?? null });
    try {
      const first = await Promise.race([work, timedOut, aborted, gone, refused]);
      if (first === "timeout") {
        this.#cancelTurn(turn, "expire");
        return { status: "failed", error: "timeout", ...partial() };
      }
      if (first === "aborted") return { status: "failed", error: "unavailable", ...partial() };
      if (first === "gone") {
        this.#log.warn("agent-bridge: the agent went away during an agent DM turn");
        return { status: "failed", error: "failed", ...partial() };
      }
      if (first === "refused") {
        this.#log.info("agent-bridge: the API refused a draft or prompt; stopping the agent DM turn");
        this.#cancelTurn(turn, "expire");
        return { status: "failed", error: "failed", ...partial() };
      }
      keep = true;
      return { status: "ok", stopReason: turn.cancelled ? "cancelled" : first, ...partial() };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = (error as Error)?.message ?? String(error);
      this.#log.warn("agent-bridge: agent DM turn failed", { code, error: message.slice(0, 300) });
      const credentials = code === AUTH_REQUIRED || /\b(api key|credential|unauthori[sz]ed|authenticat)/i.test(message);
      return { status: "failed", error: credentials ? "credentials" : "failed", ...partial() };
    } finally {
      clearTimeout(timer);
      turn.ended = true;
      turn.settleAll("expire");
      await streamer.stop();
      this.#turn = undefined;
      // A turn that didn't end normally leaves the session in a state nobody knows: start the next one afresh,
      // once the cancel and the answers to its prompts have had a moment to reach the agent.
      if (!keep && !this.#closed) {
        await new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS));
        void this.close("turn did not finish");
      } else if (!this.#closed) this.#armIdle();
    }
  }

  async #work(turn: Turn, request: DmTurnRequest, level: PermissionLevel): Promise<string> {
    const agent = this.#connection.agent;
    let text = request.prompt;
    if (!this.#initialized) {
      const init = (await agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        // The proxy forces these anyway. Notices keep its Plane-MCP warning out of the answer.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { notices: {} },
        },
        clientInfo: { name: "plane-messages", version: this.#options.clientVersion },
      } as never)) as { agentCapabilities?: { loadSession?: unknown } };
      this.#initialized = true;
      const canLoad = init.agentCapabilities?.loadSession === true;
      const setup = { cwd: "/", mcpServers: [], _meta: { [INITIAL_MODE_META_KEY]: level } };
      if (request.sessionRef && canLoad) {
        // Loading replays the conversation as updates; none of that is this turn's answer.
        this.#loading = true;
        try {
          await agent.request("session/load", { ...setup, sessionId: request.sessionRef } as never);
          this.#sessionId = request.sessionRef;
        } catch (error) {
          this.#log.info("agent-bridge: could not load the agent DM's session; starting a new one", {
            code: (error as { code?: unknown }).code,
          });
        } finally {
          this.#loading = false;
        }
      }
      if (!this.#sessionId) {
        const session = (await agent.request("session/new", setup as never)) as { sessionId: string };
        this.#sessionId = session.sessionId;
        text = request.primer;
      }
      this.#level = level;
    } else if (this.#sessionId && level !== this.#level) {
      await agent.request("session/set_mode", { sessionId: this.#sessionId, modeId: level } as never);
      this.#level = level;
    }
    if (turn.cancelled) return "cancelled";
    const result = (await agent.request("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    } as never)) as { stopReason: string };
    return result.stopReason;
  }

  #armIdle(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => void this.close("idle"), this.#options.idleTimeoutMs);
    this.#idleTimer.unref?.();
  }

  async #postDraft(turn: Turn): Promise<void> {
    if (turn.ended || turn.refused) return;
    const toolCalls = turn.toolCallList();
    if (!turn.text && toolCalls.length === 0) return;
    let result: DmPostResult;
    try {
      result = await this.#options.reporter.reportDmDraft(turn.runId, { text: turn.text, toolCalls });
    } catch {
      result = "error";
    }
    if (result === "refused") turn.refuse();
  }

  #onUpdate(params: SessionNotification): void {
    const turn = this.#turn;
    if (!turn || turn.ended || this.#loading) return;
    const update = params.update as Record<string, unknown>;
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      turn.afterTool = turn.text.length > 0;
      const id = clip(update.toolCallId);
      if (!id) return;
      const known = turn.toolCalls.get(id);
      if (!known && turn.toolCalls.size >= MAX_TOOL_CALLS) return;
      const title = clip(update.title) || known?.title || "";
      const status = typeof update.status === "string" && TOOL_STATUSES.has(update.status) ? update.status : undefined;
      turn.toolCalls.set(id, { id, title, status: (status ?? known?.status ?? "pending") as DmToolCallStatus });
      turn.streamer?.touch();
      return;
    }
    if (update.sessionUpdate !== "agent_message_chunk") return;
    const content = update.content as { type?: unknown; text?: unknown } | undefined;
    if (content?.type !== "text" || typeof content.text !== "string") return;
    // Separate what the agent said before a tool call from what it said after.
    const chunk = turn.afterTool && content.text.trim() ? `\n\n${content.text}` : content.text;
    if (content.text.trim()) turn.afterTool = false;
    turn.text = (turn.text + chunk).slice(0, MAX_REPLY_CHARS);
    turn.streamer?.touch();
  }

  /** Ask the API to put the prompt to the DM's person; if it won't, refuse the prompt now rather than at the end. */
  async #forwardPermission(
    turn: Turn,
    requestId: string,
    request: { requestId: string; title: string; options: readonly DmPermissionOption[] },
    refuse: () => RequestPermissionResponse
  ): Promise<void> {
    let result: DmPostResult;
    try {
      result = await this.#options.reporter.reportDmPermission(turn.runId, request);
    } catch {
      result = "error";
    }
    if (result === "ok") return;
    const pending = turn.permissions.get(requestId);
    if (pending) {
      turn.permissions.delete(requestId);
      pending.settle(refuse());
    }
    if (result === "refused") turn.refuse();
  }

  #onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.#turn;
    const options: DmPermissionOption[] = [];
    for (const option of params.options ?? []) {
      const optionId = typeof option.optionId === "string" ? option.optionId : "";
      if (!optionId || optionId.length > MAX_FIELD_CHARS || !OPTION_KINDS.has(option.kind)) continue;
      if (options.length >= MAX_PERMISSION_OPTIONS) break;
      options.push({ optionId, name: clip(option.name), kind: option.kind as DmPermissionOption["kind"] });
    }
    const rejectOption =
      options.find((option) => option.kind === "reject_once")?.optionId ??
      options.find((option) => option.kind === "reject_always")?.optionId;
    const refuse = (): RequestPermissionResponse =>
      rejectOption
        ? { outcome: { outcome: "selected", optionId: rejectOption } }
        : { outcome: { outcome: "cancelled" } };
    if (!turn || turn.ended || turn.cancelled || turn.refused || options.length === 0) {
      return Promise.resolve(refuse());
    }
    const requestId = randomBytes(16).toString("hex");
    const answer = new Promise<RequestPermissionResponse>((resolve) => {
      turn.permissions.set(requestId, {
        optionIds: new Set(options.map((option) => option.optionId)),
        rejectOption,
        settle: resolve,
      });
    });
    const title = typeof params.toolCall?.title === "string" ? clip(params.toolCall.title) : "";
    this.#log.info("agent-bridge: forwarding a permission prompt to the agent DM's person");
    void this.#forwardPermission(turn, requestId, { requestId, title, options }, refuse);
    return answer;
  }
}

interface RunningTurn {
  readonly runId: string;
  readonly abort: AbortController;
  session: HeldDmSession | undefined;
  /** A Stop that came while the session was still being opened. */
  cancelRequested: boolean;
  finished: Promise<void>;
}

/**
 * The agent DMs' held sessions and running turns, at most one turn per DM. A held session takes a cap slot from
 * the moment it is opened until it closes (idle, token expiry, a failed turn, the agent going away, shutdown).
 */
export class DmSessions {
  readonly #options: DmSessionsOptions;
  readonly #held = new Map<string, HeldDmSession>();
  readonly #turns = new Map<string, RunningTurn>();
  /** Slots taken for sessions being opened or held. */
  #slots = 0;
  #closing = false;

  constructor(options: DmSessionsOptions) {
    this.#options = options;
  }

  /** Held sessions. */
  get heldCount(): number {
    return this.#held.size;
  }

  /** The people whose sessions are held, for the bridge's sweep of ended workspace memberships. */
  heldMembers(): MemberRef[] {
    return [...this.#held.values()].map((session) => ({
      workspaceId: session.grant.workspace.id,
      userId: session.userId,
    }));
  }

  /** Close the held sessions (and so any turn running in them) of someone whose workspace membership ended. */
  async closeMember(member: MemberRef): Promise<void> {
    const sessions = [...this.#held.values()].filter(
      (session) => session.grant.workspace.id === member.workspaceId && session.userId === member.userId
    );
    await Promise.all(sessions.map((session) => session.close("workspace membership ended")));
  }

  /** Cap slots the DMs take (sessions being opened, and held ones). */
  get slotCount(): number {
    return this.#slots;
  }

  get runningCount(): number {
    return this.#turns.size;
  }

  /** Take a turn on (or refuse it at once). The turn runs after the answer; its outcome goes to the API. */
  start(request: DmTurnRequest): DmTurnAdmission {
    if (this.#closing) return "shutting_down";
    if (this.#turns.has(request.channelId)) return "conflict";
    let held = this.#held.get(request.channelId);
    if (held && !held.reusableFor(request)) {
      void held.close("replaced");
      held = undefined;
    }
    let release: (() => void) | undefined;
    if (!held) {
      const slot = this.#options.reserve(request.userId);
      if (!slot.ok) {
        this.#options.log.warn("agent-bridge: refused an agent DM turn", { userId: request.userId });
        return "busy";
      }
      this.#slots += 1;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        this.#slots -= 1;
        slot.release();
      };
    }
    const turn: RunningTurn = {
      runId: request.runId,
      abort: new AbortController(),
      session: held,
      cancelRequested: false,
      finished: Promise.resolve(),
    };
    this.#turns.set(request.channelId, turn);
    turn.finished = this.#run(request, turn, release).finally(() => {
      if (this.#turns.get(request.channelId) === turn) this.#turns.delete(request.channelId);
    });
    return "accepted";
  }

  answerPermission(
    channelId: string,
    runId: string,
    requestId: string,
    optionId: string
  ): "answered" | "not_found" | "bad_option" {
    const turn = this.#turns.get(channelId);
    if (!turn || turn.runId !== runId || !turn.session) return "not_found";
    return turn.session.answerPermission(runId, requestId, optionId);
  }

  /**
   * Stop the DM's turn `runId`. False only if the DM has no such turn: one that has ended but is still reporting its
   * reply counts, so that the API waits for that report instead of ending the run without it.
   */
  cancel(channelId: string, runId: string): boolean {
    const turn = this.#turns.get(channelId);
    if (!turn || turn.runId !== runId) return false;
    if (turn.session) turn.session.cancel(runId);
    else turn.cancelRequested = true;
    return true;
  }

  /** Stop every turn (each tells the API) and close every held session. */
  async close(): Promise<void> {
    this.#closing = true;
    const turns = [...this.#turns.values()];
    for (const turn of turns) turn.abort.abort();
    await Promise.all(turns.map((turn) => turn.finished));
    await Promise.all([...this.#held.values()].map((session) => session.close("bridge shutting down")));
  }

  async #run(request: DmTurnRequest, turn: RunningTurn, release: (() => void) | undefined): Promise<void> {
    const { log, reporter } = this.#options;
    let outcome: DmTurnOutcome;
    try {
      let session = turn.session;
      if (!session) {
        const opened = await this.#options.openAgent(request, turn.abort.signal);
        if (!opened.ok) {
          release?.();
          outcome = { status: "failed", error: opened.error, text: "", toolCalls: [], sessionRef: null };
        } else if (turn.abort.signal.aborted) {
          release?.();
          opened.upstream.close();
          await opened.revoke();
          outcome = { status: "failed", error: "unavailable", text: "", toolCalls: [], sessionRef: null };
        } else {
          session = new HeldDmSession({
            request,
            opened,
            release: release ?? (() => undefined),
            options: this.#options,
            onClosed: (closed) => {
              if (this.#held.get(closed.channelId) === closed) this.#held.delete(closed.channelId);
            },
          });
          this.#held.set(request.channelId, session);
          turn.session = session;
          log.info("agent-bridge: agent DM session opened", { channelId: request.channelId });
        }
      }
      if (session) {
        const running = session.runTurn(request, turn.abort.signal);
        if (turn.cancelRequested) session.cancel(request.runId);
        outcome = await running;
      }
    } catch (error) {
      log.error("agent-bridge: agent DM turn crashed", { error: (error as Error).message });
      // Once a session holds the slot, closing it frees the slot.
      if (turn.session) void turn.session.close("turn crashed");
      else release?.();
      outcome = { status: "failed", error: "failed", text: "", toolCalls: [], sessionRef: null };
    }
    try {
      await reporter.reportDmReply(request.runId, outcome!);
    } catch (error) {
      log.warn("agent-bridge: the API did not take an agent DM reply", {
        runId: request.runId,
        status: (error as { status?: unknown }).status,
      });
    }
  }
}
