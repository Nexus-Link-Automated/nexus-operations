/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { RawData, WebSocket } from "ws";

import type { GatewayConfig } from "./config.ts";
import type { ChatEvent } from "./events.ts";
import type { Hub, Recipient } from "./hub.ts";
import type { Logger } from "./logger.ts";
import { PlaneApiError, type ChannelAccess, type PlaneApi } from "./plane-api.ts";
import { CloseCode, clientMessageSchema, encode, type ErrorCode, type ServerMessage } from "./protocol.ts";

/** Events held for a socket that is still loading its channels; past this it reconnects instead. */
const MAX_QUEUED_EVENTS = 1000;
/** Channel checks one socket may have waiting on the API at once. */
const MAX_CHECKS_IN_FLIGHT = 5;
/** Refusals one socket remembers; past this the oldest is forgotten, so a client can't grow the map by guessing IDs. */
const MAX_REMEMBERED_REFUSALS = 200;
/** Times a re-read of the user's channels is repeated when an event changes them while it is under way. */
const MAX_SYNC_ATTEMPTS = 3;

export interface ConnectionOptions {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly workspace: { readonly id: string; readonly slug: string };
  /** The browser's session cookie, for asking the API about this user. Never logged or sent anywhere else. */
  readonly cookie: string;
  readonly config: GatewayConfig;
  readonly api: PlaneApi;
  readonly hub: Hub;
  readonly log: Logger;
  /** Called once, when the socket has closed. */
  readonly onClose: () => void;
}

type Verdict = "ok" | "closed" | "unknown";

/**
 * One admitted browser socket, and everything the gateway knows about what its user may see.
 *
 * A socket follows a channel in one of two ways, and only these:
 *
 * - **its feed**: the channels the user is a member of. The gateway reads them from the API when the
 *   socket opens, then keeps them current from `member.added` / `member.removed` events about the user
 *   and by re-reading them every `accessTtlMs`.
 * - **subscriptions**: public channels the user can see but hasn't joined, which the browser asked for. The API
 *   was asked when it did, and the answer is re-read with the feed.
 *
 * Every event for the workspace is handed to every socket in it, and a socket forwards only the ones for
 * channels it follows. So nothing about a channel reaches a user unless the API said they could see it, or
 * Django announced that they were added to it.
 */
export class Connection implements Recipient {
  readonly userId: string;
  readonly workspace: { readonly id: string; readonly slug: string };
  readonly #socket: WebSocket;
  readonly #cookie: string;
  readonly #config: GatewayConfig;
  readonly #api: PlaneApi;
  readonly #hub: Hub;
  readonly #log: Logger;
  readonly #onClose: () => void;
  readonly #abort = new AbortController();
  readonly #feed = new Set<string>();
  readonly #subscriptions = new Set<string>();
  /** Channels the API said the user can't see → until when to believe that without asking again. */
  readonly #denied = new Map<string, number>();
  readonly #timers: NodeJS.Timeout[] = [];
  /** Events that arrived before `ready`; `undefined` once the socket is live. */
  #queue: ChatEvent[] | undefined = [];
  /** Set while access is being re-checked after `access.revoked`: nothing is forwarded until it is confirmed. */
  #suspended = false;
  #closed = false;
  #left = false;
  #syncing = false;
  #checksInFlight = 0;
  /** Bumped whenever an event changes the feed, so a re-read that raced with one knows it is stale. */
  #feedVersion = 0;
  #rateWindowStart = Date.now();
  #rateCount = 0;
  #checkWindowStart = Date.now();
  #checkCount = 0;

  constructor(options: ConnectionOptions) {
    this.userId = options.userId;
    this.workspace = options.workspace;
    this.#socket = options.socket;
    this.#cookie = options.cookie;
    this.#config = options.config;
    this.#api = options.api;
    this.#hub = options.hub;
    this.#onClose = options.onClose;
    this.#log = options.log;
    this.#socket.on("message", (data, isBinary) => this.#onFrame(data, isBinary));
    // `ws` answers a ping by itself, so one sent without reading the answer never reaches `#send`.
    this.#socket.on("ping", () => {
      if (this.#overRate()) this.close(CloseCode.tooManyRequests, "Too many messages");
      else this.#closedForNotReading();
    });
    this.#socket.on("error", () => undefined);
    this.#socket.once("close", () => this.#teardown(true));
  }

  get workspaceId(): string {
    return this.workspace.id;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Listen to the workspace, read the user's channels, and tell the browser it is live. Never rejects. */
  async start(): Promise<void> {
    try {
      // Listening comes first: anything that happens after the channels are read is queued, not lost.
      await this.#hub.join(this);
      const { members } = await this.#loadChannels();
      if (this.#closed) return;
      this.#replaceFeed(members);
    } catch (error) {
      await this.#failToStart(error);
      return;
    }
    this.#send({ type: "ready", user_id: this.userId, workspace_id: this.workspace.id, channels: [...this.#feed] });
    const queued = this.#queue ?? [];
    this.#queue = undefined;
    for (const event of queued) this.#route(event);
    // Sending `ready` or the queued events can close the socket.
    if (this.#closed) return;
    this.#every(this.#config.accessTtlMs, () => void this.#syncAccess());
    this.#every(this.#config.sessionRecheckMs, () => void this.#verifySession());
  }

  /**
   * Run `task` every `periodMs`, the first time at a random point within the first period, so sockets that opened
   * together (a restart, a reconnect storm) don't all ask the API at the same moment for ever after.
   */
  #every(periodMs: number, task: () => void): void {
    const first = setTimeout(() => {
      task();
      const interval = setInterval(task, periodMs);
      interval.unref();
      this.#timers.push(interval);
    }, Math.random() * periodMs);
    first.unref();
    this.#timers.push(first);
  }

  deliver(event: ChatEvent): void {
    if (this.#closed) return;
    if (this.#queue) {
      if (this.#queue.length >= MAX_QUEUED_EVENTS) this.close(CloseCode.tryAgainLater, "Not keeping up");
      else this.#queue.push(event);
      return;
    }
    this.#route(event);
  }

  resync(reason: "events_missed"): void {
    if (this.#closed || this.#queue) return;
    this.#send({ type: "resync", reason });
  }

  /** Close the socket. Nothing more is sent to the browser from here on. */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#teardown(false);
    if (this.#socket.readyState === this.#socket.OPEN || this.#socket.readyState === this.#socket.CONNECTING) {
      this.#socket.close(code, reason);
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  #route(event: ChatEvent): void {
    const own = event.user_id === this.userId;
    const channel = event.channel_id;
    switch (event.type) {
      case "access.revoked":
        if (own) void this.#revoked();
        return;
      case "read.updated":
      case "agent.permission_requested":
      case "agent.permission_resolved":
        // Where someone has read up to is theirs alone, and so is an agent DM's permission prompt: only they answer it.
        if (!own) return;
        break;
      case "member.added":
        if (own && channel) {
          this.#feed.add(channel);
          this.#feedVersion += 1;
          this.#subscriptions.delete(channel);
          this.#denied.delete(channel);
        }
        break;
      case "member.removed":
        if (own && channel) {
          // Tell them they're out, then stop: nothing about the channel follows.
          if (this.#follows(channel)) this.#forward(event);
          this.#feed.delete(channel);
          this.#feedVersion += 1;
          this.#subscriptions.delete(channel);
          return;
        }
        break;
      default:
        break;
    }
    if (channel && this.#follows(channel)) this.#forward(event);
  }

  /**
   * Send an event on, unless access is being re-checked: then it is held back (the feed still takes it into
   * account above), and the re-check ends with `resync` or the socket closing.
   */
  #forward(event: ChatEvent): void {
    if (!this.#suspended) this.#send({ type: "event", event });
  }

  #follows(channel: string): boolean {
    return this.#feed.has(channel) || this.#subscriptions.has(channel);
  }

  // ── what the browser sends ────────────────────────────────────────────────

  #onFrame(data: RawData, isBinary: boolean): void {
    if (this.#closed) return;
    if (this.#overRate()) {
      this.close(CloseCode.tooManyRequests, "Too many messages");
      return;
    }
    let json: unknown;
    try {
      if (isBinary) throw new Error("binary frame");
      json = JSON.parse(String(data));
    } catch {
      this.#error("bad_request", "Send JSON text frames");
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.#error("bad_request", "Unknown or malformed message");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "ping":
        this.#send({ type: "pong" });
        return;
      case "subscribe":
        void this.#subscribe(message.channel_id.toLowerCase());
        return;
      case "unsubscribe":
        this.#unsubscribe(message.channel_id.toLowerCase());
        return;
    }
  }

  #overRate(): boolean {
    const now = Date.now();
    if (now - this.#rateWindowStart >= this.#config.rateWindowMs) {
      this.#rateWindowStart = now;
      this.#rateCount = 0;
    }
    this.#rateCount += 1;
    return this.#rateCount > this.#config.rateFrames;
  }

  #overCheckRate(): boolean {
    const now = Date.now();
    if (now - this.#checkWindowStart >= this.#config.rateWindowMs) {
      this.#checkWindowStart = now;
      this.#checkCount = 0;
    }
    if (this.#checkCount >= this.#config.rateChecks) return true;
    this.#checkCount += 1;
    return false;
  }

  async #subscribe(channel: string): Promise<void> {
    if (this.#follows(channel)) {
      this.#send({ type: "subscribed", channel_id: channel });
      return;
    }
    const deniedUntil = this.#denied.get(channel);
    if (deniedUntil !== undefined && deniedUntil > Date.now()) {
      this.#error("not_found", "Channel not found", channel);
      return;
    }
    if (this.#subscriptions.size + this.#checksInFlight >= this.#config.maxSubscriptions) {
      this.#error("too_many_subscriptions", "Too many channels followed", channel);
      return;
    }
    if (this.#checksInFlight >= MAX_CHECKS_IN_FLIGHT) {
      this.#error("unavailable", "Too many channels being checked at once", channel);
      return;
    }
    // Each check is an API call, and subscribing and unsubscribing over and over would make one every time.
    if (this.#overCheckRate()) {
      this.#error("unavailable", "Too many channels checked; try again shortly", channel);
      return;
    }

    // Ask the API, as this user: it answers 200 for a channel they can see and 404 for any other.
    const version = this.#feedVersion;
    this.#checksInFlight += 1;
    let access: ChannelAccess;
    try {
      access = await this.#api.channel(this.#cookie, this.workspace.slug, channel, this.#abort.signal);
    } catch (error) {
      if (this.#closed) return;
      if (error instanceof PlaneApiError && error.status === 404) {
        this.#refuse(channel);
        this.#error("not_found", "Channel not found", channel);
      } else if (error instanceof PlaneApiError && error.isUnauthenticated) {
        const verdict = await this.#verifySession();
        if (verdict !== "closed" && !this.#closed) {
          this.#error("unavailable", "Could not check the channel; try again", channel);
        }
      } else {
        this.#log.warn("chat-gateway: could not check a channel", { error: (error as Error).message });
        this.#error("unavailable", "Could not check the channel; try again", channel);
      }
      return;
    } finally {
      this.#checksInFlight -= 1;
    }
    if (this.#closed) return;
    // The answer may be older than a change to the user's channels, or a re-check, that happened while it travelled.
    if (version !== this.#feedVersion || this.#suspended) {
      this.#error("unavailable", "Could not check the channel; try again", channel);
      return;
    }

    if (access.is_member) {
      this.#feed.add(channel);
      this.#feedVersion += 1;
    } else {
      this.#subscriptions.add(channel);
    }
    this.#send({ type: "subscribed", channel_id: channel });
  }

  /** Remember for a while that the API said the user can't see this channel. */
  #refuse(channel: string): void {
    const now = Date.now();
    if (this.#denied.size >= MAX_REMEMBERED_REFUSALS) {
      for (const [id, until] of this.#denied) if (until <= now) this.#denied.delete(id);
      const oldest = this.#denied.size >= MAX_REMEMBERED_REFUSALS ? this.#denied.keys().next().value : undefined;
      if (oldest !== undefined) this.#denied.delete(oldest);
    }
    this.#denied.set(channel, now + this.#config.accessTtlMs);
  }

  #unsubscribe(channel: string): void {
    if (this.#subscriptions.delete(channel)) {
      this.#send({ type: "unsubscribed", channel_id: channel, reason: "requested" });
    } else if (this.#feed.has(channel)) {
      this.#error("bad_request", "Members always follow their channels; leave the channel to stop", channel);
    } else {
      this.#send({ type: "unsubscribed", channel_id: channel, reason: "requested" });
    }
  }

  // ── what the API says ─────────────────────────────────────────────────────

  /** The channels the user can see in the workspace, and the ones among them they are in. */
  async #loadChannels(): Promise<{ members: Set<string>; visible: Set<string> }> {
    const { slug } = this.workspace;
    const signal = this.#abort.signal;
    // Archived channels stay in a member's feed, so unarchiving one reaches them.
    const [live, archived] = await Promise.all([
      this.#api.channels(this.#cookie, slug, false, signal),
      this.#api.channels(this.#cookie, slug, true, signal),
    ]);
    const members = new Set<string>();
    const visible = new Set<string>();
    for (const channel of [...live, ...archived]) {
      visible.add(channel.id);
      if (channel.is_member) members.add(channel.id);
    }
    return { members, visible };
  }

  #replaceFeed(members: Set<string>): void {
    this.#feed.clear();
    for (const channel of members) this.#feed.add(channel);
  }

  /**
   * Read the user's channels again and make the feed and subscriptions match, telling the browser if its
   * channels changed under it. Catches what no event did: a missed event, a demotion, a removed channel.
   */
  async #syncAccess(force = false): Promise<boolean> {
    if (this.#closed || (this.#syncing && !force)) return false;
    this.#syncing = true;
    try {
      for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
        const version = this.#feedVersion;
        // oxlint-disable-next-line no-await-in-loop -- a retry only when an event changed the feed meanwhile
        const { members, visible } = await this.#loadChannels();
        if (this.#closed) return false;
        // An event changed the feed while this read was under way, so what was read may be older. Read again, and if
        // that keeps happening leave the feed as the events have made it; the next re-read will try again.
        if (version !== this.#feedVersion) {
          if (attempt < MAX_SYNC_ATTEMPTS) continue;
          return false;
        }

        const changed = members.size !== this.#feed.size || [...members].some((channel) => !this.#feed.has(channel));
        this.#replaceFeed(members);
        for (const channel of this.#subscriptions) {
          if (!visible.has(channel)) {
            this.#subscriptions.delete(channel);
            this.#send({ type: "unsubscribed", channel_id: channel, reason: "access_lost" });
          } else if (members.has(channel)) {
            this.#subscriptions.delete(channel);
          }
        }
        if (changed || force) this.#send({ type: "resync", reason: "membership_changed" });
        return true;
      }
      return false;
    } catch (error) {
      if (this.#closed) return false;
      if (error instanceof PlaneApiError && error.isUnauthenticated) await this.#verifySession();
      else this.#log.warn("chat-gateway: could not re-read the user's channels", { error: (error as Error).message });
      return false;
    } finally {
      this.#syncing = false;
    }
  }

  /** Is the cookie still good, and the user still in the workspace? Closes the socket if not. */
  async #verifySession(): Promise<Verdict> {
    const { slug } = this.workspace;
    const signal = this.#abort.signal;
    const [user, workspace] = await Promise.allSettled([
      this.#api.currentUser(this.#cookie, signal),
      this.#api.workspace(this.#cookie, slug, signal),
    ]);
    if (this.#closed) return "closed";
    if (user.status === "rejected") {
      if (user.reason instanceof PlaneApiError && user.reason.isUnauthenticated) {
        this.close(CloseCode.unauthenticated, "Not signed in");
        return "closed";
      }
      this.#log.warn("chat-gateway: could not re-check the session", { error: (user.reason as Error).message });
      return "unknown";
    }
    if (user.value.id !== this.userId) {
      this.close(CloseCode.unauthenticated, "Not signed in");
      return "closed";
    }
    if (workspace.status === "rejected") {
      const status = workspace.reason instanceof PlaneApiError ? workspace.reason.status : 0;
      if (status === 401 || status === 403 || status === 404) {
        this.close(CloseCode.forbidden, "Not a member of this workspace");
        return "closed";
      }
      this.#log.warn("chat-gateway: could not re-check workspace membership", {
        error: (workspace.reason as Error).message,
      });
      return "unknown";
    }
    return "ok";
  }

  /**
   * Django says this user's access to the workspace ended. Stop sending at once, check with the API, and
   * either close the socket or carry on with what the API says now.
   */
  async #revoked(): Promise<void> {
    if (this.#suspended) return;
    this.#suspended = true;
    const verdict = await this.#verifySession();
    if (verdict === "closed" || this.#closed) return;
    // Couldn't tell. They were told it ended, so don't keep sending on a guess; they can reconnect.
    if (verdict === "unknown") {
      this.close(CloseCode.internalError, "Could not re-check access");
      return;
    }
    // What was held back is gone, so the browser has to refetch; and the feed must be right before anything flows.
    const synced = await this.#syncAccess(true);
    if (this.#closed) return;
    if (!synced) {
      this.close(CloseCode.internalError, "Could not re-check access");
      return;
    }
    this.#suspended = false;
  }

  async #failToStart(error: unknown): Promise<void> {
    if (this.#closed) return;
    if (error instanceof PlaneApiError && (error.isUnauthenticated || error.status === 404)) {
      // The workspace check just passed, so this is a change since, or the cookie. Let the API's answers decide.
      const verdict = await this.#verifySession();
      if (verdict === "closed" || this.#closed) return;
    }
    this.#log.error("chat-gateway: could not start a socket", { error: (error as Error).message });
    this.close(CloseCode.internalError, "Live updates are unavailable");
  }

  // ── sending and closing ───────────────────────────────────────────────────

  #send(message: ServerMessage): void {
    if (this.#closed || this.#socket.readyState !== this.#socket.OPEN || this.#closedForNotReading()) return;
    this.#socket.send(encode(message));
  }

  /** A browser that has stopped reading would otherwise have everything sent to it held in memory, without limit. */
  #closedForNotReading(): boolean {
    if (this.#socket.bufferedAmount <= this.#config.maxBufferedBytes) return false;
    this.close(CloseCode.tryAgainLater, "Not keeping up");
    return true;
  }

  #error(code: ErrorCode, message: string, channelId?: string): void {
    this.#send({ type: "error", code, message, ...(channelId ? { channel_id: channelId } : {}) });
  }

  /** Stop everything this connection started. `finished` is true once the socket has actually closed. */
  #teardown(finished: boolean): void {
    this.#closed = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.length = 0;
    this.#abort.abort();
    if (!this.#left) {
      this.#left = true;
      this.#hub.leave(this);
    }
    if (finished) {
      this.#onClose();
    }
  }
}
