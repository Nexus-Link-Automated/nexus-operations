/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CHAT_GATEWAY_BASE_PATH, CHAT_GATEWAY_BASE_URL } from "@plane/constants";
import type { TChatClientFrame, TChatEvent, TChatServerFrame } from "@plane/types";

/** The chat gateway's close codes (`apps/chat-gateway/src/protocol.ts`). */
export const ChatCloseCode = {
  normal: 1000,
  goingAway: 1001,
  abnormal: 1006,
  internalError: 1011,
  tryAgainLater: 1013,
  badRequest: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  tooManyRequests: 4429,
} as const;

/**
 * - `connecting`: the first connection is opening, or waiting for `ready`.
 * - `ready`: admitted; events flow.
 * - `reconnecting`: the socket dropped and a retry is scheduled or under way.
 * - `paused`: closed on purpose because the user went idle; the next `noteActivity()` reopens it. Not a fault.
 * - `closed`: stopped for good, either by `close()` or because the gateway said not to retry (`closedReason`).
 */
export type TChatSocketStatus = "idle" | "connecting" | "ready" | "reconnecting" | "paused" | "closed";

/** Why the socket stopped for good: sign in again, not a member (any more), or a bad request. */
export type TChatSocketClosedReason = "unauthenticated" | "forbidden" | "bad_request";

/** What a `message` or `close` event carries, as far as this client reads it. */
export type TChatSocketEvent = { data?: unknown; code?: number };

type TChatSocketListener = (event: TChatSocketEvent) => void;

/** The parts of the browser's `WebSocket` this client uses, so tests can pass a fake. */
export interface ChatWebSocketLike {
  readonly readyState: number;
  addEventListener(type: "message" | "close", listener: TChatSocketListener): void;
  removeEventListener(type: "message" | "close", listener: TChatSocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TChatSocketHandlers = {
  /** Admitted. `reconnected` is true for every `ready` after the first: whatever happened in between is unknown. */
  onReady?: (frame: Extract<TChatServerFrame, { type: "ready" }>, reconnected: boolean) => void;
  onEvent?: (event: TChatEvent) => void;
  /** The gateway may have dropped events, or the user's channels changed without one: refetch. */
  onResync?: (reason: Extract<TChatServerFrame, { type: "resync" }>["reason"]) => void;
  onSubscribed?: (channelId: string) => void;
  onUnsubscribed?: (channelId: string, reason: "requested" | "access_lost") => void;
  onError?: (frame: Extract<TChatServerFrame, { type: "error" }>) => void;
  onStatusChange?: (status: TChatSocketStatus, closedReason: TChatSocketClosedReason | null) => void;
};

export type TChatSocketOptions = TChatSocketHandlers & {
  workspaceSlug: string;
  /** The gateway origin; empty means the page's own origin. Defaults to `CHAT_GATEWAY_BASE_URL`. */
  baseUrl?: string;
  /** The gateway mount path. Defaults to `CHAT_GATEWAY_BASE_PATH`. */
  basePath?: string;
  /** Injectable for tests. Defaults to `new WebSocket(url)`. */
  createWebSocket?: (url: string) => ChatWebSocketLike;
  /** How often to ping once ready. The gateway answers with `pong`. */
  pingIntervalMs?: number;
  /** A socket that sends nothing for this long after a ping is treated as dead and reopened. */
  pongTimeoutMs?: number;
  /** Retry delays: `initial * 2^attempt`, capped at `max`, with jitter. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** With no `noteActivity()` for this long, the socket is closed until the next one. */
  idleTimeoutMs?: number;
  /** For tests: a value in [0, 1) used for jitter. */
  random?: () => number;
};

const OPEN = 1;

/** `value` without trailing slashes (a loop, not a regex, so long inputs stay linear). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/**
 * The socket URL, `<origin><basePath>/ws?workspace=<slug>`. Only the origin of `baseUrl` is used; without one the
 * page's own origin is (the gateway authenticates the session cookie, so it must be same-site anyway).
 */
export function chatSocketUrl(options: { workspaceSlug: string; baseUrl?: string; basePath?: string }): string {
  const mount = trimTrailingSlashes(options.basePath?.trim() || "/chat");
  const path = `${mount.startsWith("/") ? mount : `/${mount}`}/ws`;
  const base = options.baseUrl?.trim() || (typeof window === "undefined" ? "" : window.location.origin);
  if (!base) throw new Error("chatSocketUrl: no base URL and no page origin");
  const url = new URL(path, new URL(base).origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("workspace", options.workspaceSlug);
  return url.toString();
}

function parseFrame(data: unknown): TChatServerFrame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const frame = JSON.parse(data) as unknown;
    if (frame && typeof frame === "object" && typeof (frame as { type?: unknown }).type === "string") {
      return frame as TChatServerFrame;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * The browser side of the chat gateway's socket (`apps/chat-gateway/README.md`). It keeps one socket open for a
 * workspace: it waits for `ready` before anything else, re-sends the explicit subscriptions after every `ready`,
 * pings to notice a dead socket, and reconnects with backoff unless the gateway said not to (4400, 4401, 4403).
 *
 * Its pings would keep a socket open for as long as a tab is, so it closes itself after `idleTimeoutMs` without
 * `noteActivity()` and reopens on the next one, with no backoff.
 *
 * It holds no chat data. The owner fetches over REST on `onReady(…, reconnected)` and `onResync`.
 */
export class ChatSocket {
  readonly url: string;

  private readonly options: TChatSocketOptions;
  private readonly createWebSocket: (url: string) => ChatWebSocketLike;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly idleTimeoutMs: number;
  private readonly random: () => number;

  private socket: ChatWebSocketLike | null = null;
  private detach: (() => void) | null = null;
  private stopped = false;
  private paused = false;
  private lastActivityAt = 0;
  private admitted = false;
  private everReady = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscriptions = new Set<string>();

  status: TChatSocketStatus = "idle";
  closedReason: TChatSocketClosedReason | null = null;

  constructor(options: TChatSocketOptions) {
    this.options = options;
    this.url = chatSocketUrl({
      workspaceSlug: options.workspaceSlug,
      baseUrl: options.baseUrl ?? CHAT_GATEWAY_BASE_URL,
      basePath: options.basePath ?? CHAT_GATEWAY_BASE_PATH,
    });
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as ChatWebSocketLike);
    this.pingIntervalMs = options.pingIntervalMs ?? 25_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.random = options.random ?? Math.random;
  }

  /** Open the socket. Does nothing if it is already open or opening. */
  connect(): void {
    if (this.socket || this.retryTimer) return;
    this.stopped = false;
    this.closedReason = null;
    this.startIdleClock();
    this.open(this.takePaused() ? "connecting" : undefined);
  }

  /**
   * The user did something. Pushes the idle deadline back, and reopens a socket that was closed for being idle. Cheap
   * enough to call on every mouse move: it only records the time, and the idle timer re-arms itself when it fires.
   */
  noteActivity(): void {
    this.lastActivityAt = Date.now();
    if (!this.takePaused()) return;
    this.startIdleClock();
    // A quick, expected reopen: `connecting`, so nothing tells the user it dropped. A real failure still reports.
    this.open("connecting");
  }

  /** Close for good: no reconnect. */
  close(): void {
    this.stopped = true;
    this.paused = false;
    this.clearIdleTimer();
    this.clearRetry();
    this.teardown(ChatCloseCode.normal);
    this.setStatus("closed", null);
  }

  /** Reconnect now instead of waiting out the backoff (e.g. the browser came back online). An idle socket stays shut. */
  reconnectNow(): void {
    if (this.stopped || this.closedReason || this.paused) return;
    if (this.socket && this.admitted) return;
    this.clearRetry();
    this.teardown(ChatCloseCode.normal);
    this.open();
  }

  /**
   * Follow a public channel the user can see but hasn't joined. Kept across reconnects. Asking again re-sends it:
   * after the user's own `member.removed` the gateway stops following the channel, so a page still showing it must
   * subscribe again even though it had before.
   */
  subscribe(channelId: string): void {
    this.subscriptions.add(channelId);
    if (this.admitted) this.send({ type: "subscribe", channel_id: channelId });
  }

  unsubscribe(channelId: string): void {
    if (!this.subscriptions.delete(channelId)) return;
    if (this.admitted) this.send({ type: "unsubscribe", channel_id: channelId });
  }

  /** The channels followed explicitly (not the user's own, which the gateway follows on its own). */
  get subscribedChannels(): string[] {
    return [...this.subscriptions];
  }

  private open(status: TChatSocketStatus = this.everReady ? "reconnecting" : "connecting"): void {
    this.admitted = false;
    this.setStatus(status, null);
    let socket: ChatWebSocketLike;
    try {
      socket = this.createWebSocket(this.url);
    } catch {
      this.scheduleRetry(false);
      return;
    }
    this.socket = socket;
    // An `error` event is always followed by `close`, which decides what happens next.
    const onMessage: TChatSocketListener = (event) => {
      if (this.socket === socket) this.handleFrame(event.data);
    };
    const onClose: TChatSocketListener = (event) => {
      if (this.socket === socket) this.handleClose(event.code ?? ChatCloseCode.abnormal);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    this.detach = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
  }

  private handleFrame(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    // Any frame shows the socket is alive.
    this.clearPongTimer();
    if (!this.admitted) {
      if (frame.type !== "ready") return;
      this.admitted = true;
      this.attempt = 0;
      const reconnected = this.everReady;
      this.everReady = true;
      for (const channelId of this.subscriptions) this.send({ type: "subscribe", channel_id: channelId });
      this.startPinging();
      this.setStatus("ready", null);
      this.options.onReady?.(frame, reconnected);
      return;
    }
    switch (frame.type) {
      case "event":
        this.options.onEvent?.(frame.event);
        break;
      case "resync":
        this.options.onResync?.(frame.reason);
        break;
      case "subscribed":
        this.options.onSubscribed?.(frame.channel_id);
        break;
      case "unsubscribed":
        // Access lost: asking again would only be refused again until something changes (e.g. a re-join).
        if (frame.reason === "access_lost") this.subscriptions.delete(frame.channel_id);
        this.options.onUnsubscribed?.(frame.channel_id, frame.reason);
        break;
      case "error":
        if (frame.channel_id && (frame.code === "not_found" || frame.code === "too_many_subscriptions")) {
          this.subscriptions.delete(frame.channel_id);
        }
        this.options.onError?.(frame);
        break;
      default:
        break;
    }
  }

  private handleClose(code: number): void {
    this.detach?.();
    this.detach = null;
    this.socket = null;
    this.admitted = false;
    this.stopTimers();
    if (this.stopped) return;
    if (code === ChatCloseCode.unauthenticated) return this.stop("unauthenticated");
    if (code === ChatCloseCode.forbidden) return this.stop("forbidden");
    if (code === ChatCloseCode.badRequest) return this.stop("bad_request");
    this.scheduleRetry(code === ChatCloseCode.tooManyRequests);
  }

  private stop(reason: TChatSocketClosedReason): void {
    this.stopped = true;
    this.clearIdleTimer();
    this.closedReason = reason;
    this.setStatus("closed", reason);
  }

  private scheduleRetry(slow: boolean): void {
    this.socket = null;
    this.setStatus(this.everReady ? "reconnecting" : "connecting", null);
    const base = slow ? Math.max(this.initialBackoffMs * 5, 5_000) : this.initialBackoffMs;
    const ceiling = Math.min(this.maxBackoffMs, base * 2 ** this.attempt);
    this.attempt += 1;
    // Full jitter on the upper half, so a gateway restart doesn't bring every tab back at once.
    const delay = Math.round(ceiling / 2 + (ceiling / 2) * this.random());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private startIdleClock(): void {
    this.lastActivityAt = Date.now();
    this.armIdleTimer(this.idleTimeoutMs);
  }

  private armIdleTimer(delay: number): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const remaining = this.lastActivityAt + this.idleTimeoutMs - Date.now();
      if (remaining > 0) this.armIdleTimer(remaining);
      else this.pause();
    }, delay);
  }

  /** Close because the user is idle: no retry, and whatever was pending is dropped. */
  private pause(): void {
    this.paused = true;
    this.clearRetry();
    this.teardown(ChatCloseCode.normal);
    this.setStatus("paused", null);
  }

  /** Whether the socket was paused; it no longer is. */
  private takePaused(): boolean {
    const paused = this.paused;
    this.paused = false;
    return paused;
  }

  private startPinging(): void {
    this.stopTimers();
    this.pingTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== OPEN) return;
      this.send({ type: "ping" });
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.pongTimer = null;
          // No answer: the socket is dead even if the browser hasn't noticed. Drop it and reconnect.
          const dead = this.socket;
          this.teardown(ChatCloseCode.normal);
          if (dead && !this.stopped) this.scheduleRetry(false);
        }, this.pongTimeoutMs);
      }
    }, this.pingIntervalMs);
  }

  private send(frame: TChatClientFrame): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  /** Forget the current socket (its handlers stop counting) and close it. */
  private teardown(code: number): void {
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    this.admitted = false;
    this.detach?.();
    this.detach = null;
    if (!socket) return;
    try {
      socket.close(code);
    } catch {
      // already closing
    }
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(status: TChatSocketStatus, closedReason: TChatSocketClosedReason | null): void {
    if (this.status === status && this.closedReason === closedReason) return;
    this.status = status;
    this.closedReason = closedReason;
    this.options.onStatusChange?.(status, closedReason);
  }
}
