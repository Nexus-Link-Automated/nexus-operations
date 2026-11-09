/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TChatServerFrame } from "@plane/types";
import { ChatCloseCode, ChatSocket, chatSocketUrl } from "./chat-socket";
import type { ChatWebSocketLike, TChatSocketEvent, TChatSocketOptions } from "./chat-socket";

type Listener = (event: TChatSocketEvent) => void;

class FakeWebSocket implements ChatWebSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  closedWith: number | undefined;
  readonly listeners = { message: new Set<Listener>(), close: new Set<Listener>() };

  constructor(readonly url: string) {}

  addEventListener(type: "message" | "close", listener: Listener) {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: "message" | "close", listener: Listener) {
    this.listeners[type].delete(listener);
  }

  /** The server side: the upgrade completed. */
  accept() {
    this.readyState = 1;
  }

  receive(frame: TChatServerFrame | string) {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const listener of this.listeners.message) listener({ data });
  }

  ready(channels: string[] = []) {
    this.accept();
    this.receive({ type: "ready", user_id: "u1", workspace_id: "w1", channels });
  }

  /** The server (or the network) closed it. */
  drop(code: number) {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({ code });
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
}

function setup(options: Partial<TChatSocketOptions> = {}) {
  const sockets: FakeWebSocket[] = [];
  const handlers = {
    onReady: vi.fn(),
    onEvent: vi.fn(),
    onResync: vi.fn(),
    onUnsubscribed: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
  };
  const client = new ChatSocket({
    workspaceSlug: "acme",
    baseUrl: "https://ops.example.com",
    basePath: "/chat",
    random: () => 0.5,
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...handlers,
    ...options,
  });
  return { client, sockets, current: () => sockets[sockets.length - 1]!, ...handlers };
}

const statuses = (onStatusChange: ReturnType<typeof vi.fn>) => onStatusChange.mock.calls.map((call) => call[0]);

describe("chatSocketUrl", () => {
  it.each([
    ["https://ops.example.com", "/chat", "wss://ops.example.com/chat/ws?workspace=acme"],
    ["https://ops.example.com/ignored/path", "/chat/", "wss://ops.example.com/chat/ws?workspace=acme"],
    ["http://localhost:3420", "chat", "ws://localhost:3420/chat/ws?workspace=acme"],
    ["http://localhost:3420", "", "ws://localhost:3420/chat/ws?workspace=acme"],
  ])("builds the URL from base %j and path %j", (baseUrl, basePath, expected) => {
    expect(chatSocketUrl({ workspaceSlug: "acme", baseUrl, basePath })).toBe(expected);
  });

  it("escapes the workspace slug", () => {
    expect(chatSocketUrl({ workspaceSlug: "a&b", baseUrl: "http://x" })).toBe("ws://x/chat/ws?workspace=a%26b");
  });
});

describe("ChatSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for ready before reporting anything", () => {
    const { client, current, onReady, onEvent, onStatusChange } = setup();
    client.connect();
    expect(client.status).toBe("connecting");
    current().accept();
    current().receive({ type: "event", event: { type: "message.created", workspace_id: "w1", at: "t" } });
    expect(onEvent).not.toHaveBeenCalled();

    current().receive({ type: "ready", user_id: "u1", workspace_id: "w1", channels: ["c1"] });
    expect(client.status).toBe("ready");
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ channels: ["c1"] }), false);
    expect(onStatusChange).toHaveBeenLastCalledWith("ready", null);

    const event = { type: "message.created" as const, workspace_id: "w1", channel_id: "c1", at: "t" };
    current().receive({ type: "event", event });
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("ignores frames that aren't JSON objects with a type", () => {
    const { client, current, onEvent } = setup();
    client.connect();
    current().ready();
    current().receive("not json");
    current().receive("[1,2]");
    expect(onEvent).not.toHaveBeenCalled();
    expect(client.status).toBe("ready");
  });

  it("sends subscriptions after ready, and again after every reconnect", () => {
    const { client, current, sockets } = setup();
    client.subscribe("c1");
    client.connect();
    current().accept();
    expect(current().sent).toEqual([]);
    current().receive({ type: "ready", user_id: "u1", workspace_id: "w1", channels: [] });
    expect(current().sent).toEqual([{ type: "subscribe", channel_id: "c1" }]);

    client.subscribe("c2");
    // Asking again re-sends: the gateway may have stopped following it (the user's own member.removed).
    client.subscribe("c2");
    expect(current().sent).toEqual([
      { type: "subscribe", channel_id: "c1" },
      { type: "subscribe", channel_id: "c2" },
      { type: "subscribe", channel_id: "c2" },
    ]);
    client.unsubscribe("c1");
    expect(current().sent.at(-1)).toEqual({ type: "unsubscribe", channel_id: "c1" });

    current().drop(ChatCloseCode.goingAway);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    current().ready();
    expect(current().sent).toEqual([{ type: "subscribe", channel_id: "c2" }]);
  });

  it("forgets a subscription the gateway refused or revoked", () => {
    const { client, current, onUnsubscribed, onError } = setup();
    client.subscribe("c1");
    client.subscribe("c2");
    client.connect();
    current().ready();
    current().receive({ type: "unsubscribed", channel_id: "c1", reason: "access_lost" });
    current().receive({ type: "error", code: "not_found", message: "no", channel_id: "c2" });
    expect(onUnsubscribed).toHaveBeenCalledWith("c1", "access_lost");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "not_found" }));
    expect(client.subscribedChannels).toEqual([]);
  });

  it("reports a reconnect as such, so the owner refetches", () => {
    const { client, current, onReady } = setup();
    client.connect();
    current().ready();
    current().drop(ChatCloseCode.internalError);
    expect(client.status).toBe("reconnecting");
    vi.advanceTimersByTime(1_000);
    current().ready();
    expect(onReady).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  it("passes resync on", () => {
    const { client, current, onResync } = setup();
    client.connect();
    current().ready();
    current().receive({ type: "resync", reason: "events_missed" });
    expect(onResync).toHaveBeenCalledWith("events_missed");
  });

  it.each([
    [ChatCloseCode.unauthenticated, "unauthenticated"],
    [ChatCloseCode.forbidden, "forbidden"],
    [ChatCloseCode.badRequest, "bad_request"],
  ] as const)("stops for good on %i", (code, reason) => {
    const { client, current, sockets, onStatusChange } = setup();
    client.connect();
    current().ready();
    current().drop(code);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe("closed");
    expect(client.closedReason).toBe(reason);
    expect(onStatusChange).toHaveBeenLastCalledWith("closed", reason);
    client.reconnectNow();
    expect(sockets).toHaveLength(1);
  });

  it("backs off exponentially, with a cap, and resets once a socket has stayed up", () => {
    const { client, current, sockets } = setup({ initialBackoffMs: 1000, maxBackoffMs: 8000 });
    client.connect();
    // random() = 0.5, so each delay is 3/4 of the ceiling: 750, 1500, 3000, 6000, 6000.
    const delays = [750, 1500, 3000, 6000, 6000];
    for (const [i, delay] of delays.entries()) {
      current().drop(ChatCloseCode.abnormal);
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(i + 2);
    }
    current().ready();
    vi.advanceTimersByTime(30_000);
    current().drop(ChatCloseCode.abnormal);
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(delays.length + 2);
  });

  it("keeps backing off a socket that closes right after ready", () => {
    const { client, current, sockets } = setup({ initialBackoffMs: 1000, maxBackoffMs: 8000 });
    client.connect();
    current().drop(ChatCloseCode.abnormal);
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(2);
    current().ready();
    current().drop(ChatCloseCode.abnormal);
    vi.advanceTimersByTime(1499);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it("reopens a socket that never says ready, and stops counting once it does", () => {
    const { client, current, sockets } = setup({ readyTimeoutMs: 1000, initialBackoffMs: 100 });
    client.connect();
    current().accept();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets[0]!.closedWith).toBe(ChatCloseCode.normal);
    vi.advanceTimersByTime(75);
    expect(sockets).toHaveLength(2);
    current().ready();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.closedWith).toBeUndefined();
  });

  it("asks again for a channel the gateway couldn't check, a limited number of times", () => {
    const { client, current } = setup({ initialBackoffMs: 1000, maxBackoffMs: 1000 });
    const subscribes = () => current().sent.filter((f) => (f as { type: string }).type === "subscribe");
    client.connect();
    current().ready();
    client.subscribe("c1");
    expect(subscribes()).toHaveLength(1);
    for (let tries = 1; tries <= 5; tries++) {
      current().receive({ type: "error", code: "unavailable", message: "try again", channel_id: "c1" });
      vi.advanceTimersByTime(750);
      expect(subscribes()).toHaveLength(1 + tries);
    }
    current().receive({ type: "error", code: "unavailable", message: "try again", channel_id: "c1" });
    vi.advanceTimersByTime(5000);
    expect(subscribes()).toHaveLength(6);
  });

  it("doesn't ask again for a channel it stopped following", () => {
    const { client, current } = setup({ initialBackoffMs: 1000 });
    client.connect();
    current().ready();
    client.subscribe("c1");
    current().receive({ type: "error", code: "unavailable", message: "try again", channel_id: "c1" });
    client.unsubscribe("c1");
    vi.advanceTimersByTime(5000);
    expect(current().sent.filter((f) => (f as { type: string }).type === "subscribe")).toHaveLength(1);
  });

  it("unsubscribes again when a channel it dropped finishes subscribing late", () => {
    const onSubscribed = vi.fn();
    const { client, current } = setup({ onSubscribed });
    client.connect();
    current().ready();
    client.subscribe("c1");
    client.unsubscribe("c1");
    current().receive({ type: "subscribed", channel_id: "c1" });
    expect(current().sent.filter((f) => (f as { type: string }).type === "unsubscribe")).toHaveLength(2);
    expect(onSubscribed).not.toHaveBeenCalled();
  });

  it("keeps a secure scheme for a wss base URL", () => {
    expect(chatSocketUrl({ workspaceSlug: "acme", baseUrl: "wss://ops.example.com", basePath: "/chat" })).toBe(
      "wss://ops.example.com/chat/ws?workspace=acme"
    );
  });

  it("waits longer after 4429", () => {
    const { client, current, sockets } = setup({ initialBackoffMs: 1000 });
    client.connect();
    current().ready();
    current().drop(ChatCloseCode.tooManyRequests);
    vi.advanceTimersByTime(3000);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("pings, and reopens a socket that stops answering", () => {
    const { client, current, sockets } = setup({
      pingIntervalMs: 1000,
      pongTimeoutMs: 500,
      initialBackoffMs: 100,
      readyTimeoutMs: 120_000,
    });
    client.connect();
    current().ready();
    vi.advanceTimersByTime(1000);
    expect(current().sent).toEqual([{ type: "ping" }]);
    current().receive({ type: "pong" });
    vi.advanceTimersByTime(600);
    expect(sockets).toHaveLength(1);

    // The next ping goes unanswered.
    vi.advanceTimersByTime(400);
    expect(current().sent).toHaveLength(2);
    vi.advanceTimersByTime(500);
    const dead = sockets[0]!;
    expect(dead.closedWith).toBe(ChatCloseCode.normal);
    expect(client.status).toBe("reconnecting");
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    // The dead socket's late close doesn't schedule another retry; its listeners are gone.
    expect(dead.listeners.close.size).toBe(0);
    dead.drop(ChatCloseCode.abnormal);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("close() stops reconnecting, and connect() starts again", () => {
    const { client, current, sockets } = setup();
    client.connect();
    current().ready();
    current().drop(ChatCloseCode.abnormal);
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe("closed");
    expect(client.closedReason).toBeNull();

    client.connect();
    expect(sockets).toHaveLength(2);
    current().ready();
    client.close();
    expect(current().closedWith).toBe(ChatCloseCode.normal);
  });

  it("reconnectNow skips the backoff", () => {
    const { client, current, sockets } = setup({ initialBackoffMs: 10_000 });
    client.connect();
    current().ready();
    current().drop(ChatCloseCode.abnormal);
    client.reconnectNow();
    expect(sockets).toHaveLength(2);
    // An admitted socket is left alone.
    current().ready();
    client.reconnectNow();
    expect(sockets).toHaveLength(2);
  });

  it("retries when the socket can't even be created", () => {
    let fail = true;
    const sockets: FakeWebSocket[] = [];
    const client = new ChatSocket({
      workspaceSlug: "acme",
      baseUrl: "http://x",
      random: () => 0,
      initialBackoffMs: 100,
      createWebSocket: (url) => {
        if (fail) throw new Error("blocked");
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    client.connect();
    expect(client.status).toBe("connecting");
    fail = false;
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(1);
  });

  describe("going idle", () => {
    const MINUTE = 60_000;

    function connected(options: Partial<TChatSocketOptions> = {}) {
      // The fake never answers pings, and an unanswered ping reopens the socket; these tests are about idling.
      const context = setup({ idleTimeoutMs: 30 * MINUTE, pingIntervalMs: 24 * 60 * MINUTE, ...options });
      context.client.connect();
      context.current().ready();
      context.onStatusChange.mockClear();
      return context;
    }

    it("closes after the timeout with no activity, without a retry or a reconnecting status", () => {
      const { client, sockets, current, onStatusChange } = connected();
      vi.advanceTimersByTime(30 * MINUTE - 1);
      expect(client.status).toBe("ready");
      vi.advanceTimersByTime(1);
      expect(client.status).toBe("paused");
      expect(current().closedWith).toBe(ChatCloseCode.normal);
      // An hour later it still hasn't tried to come back.
      vi.advanceTimersByTime(60 * MINUTE);
      expect(sockets).toHaveLength(1);
      expect(statuses(onStatusChange)).toEqual(["paused"]);
    });

    it("defaults to 30 minutes", () => {
      const { client, current } = setup({ pingIntervalMs: 24 * 60 * MINUTE });
      client.connect();
      current().ready();
      vi.advanceTimersByTime(30 * MINUTE - 1);
      expect(client.status).toBe("ready");
      vi.advanceTimersByTime(1);
      expect(client.status).toBe("paused");
    });

    it("counts from the latest activity", () => {
      const { client } = connected();
      vi.advanceTimersByTime(20 * MINUTE);
      client.noteActivity();
      vi.advanceTimersByTime(29 * MINUTE);
      expect(client.status).toBe("ready");
      vi.advanceTimersByTime(MINUTE);
      expect(client.status).toBe("paused");
    });

    it("doesn't count a ping or an inbound frame as the user being here", () => {
      const { client, current } = connected({ pingIntervalMs: 25_000 });
      for (let elapsed = 0; elapsed < 30 * MINUTE; elapsed += 20_000) {
        vi.advanceTimersByTime(20_000);
        current().receive({ type: "pong" });
      }
      expect(client.status).toBe("paused");
    });

    it("reopens on the next activity, quietly, and reports it as a reconnect so the owner catches up", () => {
      const { client, sockets, current, onStatusChange, onReady } = connected();
      client.subscribe("c-open");
      vi.advanceTimersByTime(30 * MINUTE);
      onStatusChange.mockClear();
      onReady.mockClear();

      client.noteActivity();
      expect(sockets).toHaveLength(2);
      expect(statuses(onStatusChange)).toEqual(["connecting"]);
      current().ready();
      expect(onReady.mock.calls[0]![1]).toBe(true);
      expect(current().sent).toContainEqual({ type: "subscribe", channel_id: "c-open" });
      expect(statuses(onStatusChange)).toEqual(["connecting", "ready"]);
    });

    it("can go idle again after coming back", () => {
      const { client, current } = connected();
      vi.advanceTimersByTime(30 * MINUTE);
      client.noteActivity();
      current().ready();
      vi.advanceTimersByTime(30 * MINUTE);
      expect(client.status).toBe("paused");
    });

    it("doesn't open a second socket for activity while connected", () => {
      const { client, sockets } = connected();
      client.noteActivity();
      client.noteActivity();
      expect(sockets).toHaveLength(1);
    });

    it("stays shut when the browser comes back online", () => {
      const { client, sockets } = connected();
      vi.advanceTimersByTime(30 * MINUTE);
      client.reconnectNow();
      expect(sockets).toHaveLength(1);
      expect(client.status).toBe("paused");
    });

    it("drops a pending retry when it goes idle", () => {
      const { client, sockets, current } = connected({ maxBackoffMs: 60 * MINUTE, initialBackoffMs: 60 * MINUTE });
      vi.advanceTimersByTime(29 * MINUTE);
      current().drop(ChatCloseCode.abnormal);
      vi.advanceTimersByTime(MINUTE);
      expect(client.status).toBe("paused");
      vi.advanceTimersByTime(120 * MINUTE);
      expect(sockets).toHaveLength(1);
    });

    it("reports a real failure while coming back, and retries it with backoff", () => {
      const { client, sockets, current, onStatusChange } = connected();
      vi.advanceTimersByTime(30 * MINUTE);
      client.noteActivity();
      onStatusChange.mockClear();
      current().drop(ChatCloseCode.abnormal);
      expect(statuses(onStatusChange)).toEqual(["reconnecting"]);
      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(3);
    });

    it("stays closed after close(), even if the user comes back", () => {
      const { client, sockets } = connected();
      vi.advanceTimersByTime(30 * MINUTE);
      client.close();
      client.noteActivity();
      expect(sockets).toHaveLength(1);
      expect(client.status).toBe("closed");
    });

    it("doesn't overwrite 'sign in again' when the idle timeout passes", () => {
      const { client, current } = connected();
      current().drop(ChatCloseCode.unauthenticated);
      vi.advanceTimersByTime(60 * MINUTE);
      expect(client.status).toBe("closed");
      expect(client.closedReason).toBe("unauthenticated");
      client.noteActivity();
      expect(client.status).toBe("closed");
    });

    it("doesn't send anything while paused, and subscribes on the way back", () => {
      const { client, current } = connected();
      vi.advanceTimersByTime(30 * MINUTE);
      const paused = current();
      const sent = paused.sent.length;
      client.subscribe("c-later");
      expect(paused.sent).toHaveLength(sent);
      client.noteActivity();
      current().ready();
      expect(current().sent).toContainEqual({ type: "subscribe", channel_id: "c-later" });
    });
  });
});
