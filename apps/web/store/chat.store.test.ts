/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { sortBy } from "lodash-es";
import { describe, expect, it, vi } from "vitest";
import { ChatServiceError } from "@plane/services";
import type { TChatSocketHandlers } from "@plane/services";
import type {
  TChatChannel,
  TChatChannelKind,
  TChatEvent,
  TChatMessage,
  TChatMessagePage,
  TChatMessagePageQuery,
} from "@plane/types";
import { ChatStore } from "./chat.store";
import type { TChatStoreService, TChatStoreSocket } from "./chat.store";

const ME = "user-me";
const ADA = "user-ada";
const SLUG = "acme";
const WORKSPACE_ID = "ws-1";

type ServerChannel = {
  id: string;
  kind: TChatChannelKind;
  name: string;
  members: Set<string>;
  archived: boolean;
  cursors: Map<string, string>;
};

/**
 * The chat API in memory, with the rules the store relies on: keyset pages oldest to newest with `has_more`,
 * a channel the caller can't see is a 404, unread counts top-level messages after the cursor that aren't theirs.
 */
const clone = <T>(value: T): T => structuredClone(value);

class FakeChatServer {
  channels = new Map<string, ServerChannel>();
  messages: TChatMessage[] = [];
  calls: string[] = [];
  failSends = false;
  /** Holds the next answer of a call back until the promise resolves. The answer is read when the call arrives. */
  holds = new Map<string, Promise<void>>();
  private clock = 0;
  private ids = 0;

  addChannel(id: string, options: { kind?: TChatChannelKind; members?: string[]; name?: string } = {}) {
    this.channels.set(id, {
      id,
      kind: options.kind ?? "public",
      name: options.name ?? id,
      members: new Set(options.members ?? [ME]),
      archived: false,
      cursors: new Map(),
    });
  }

  post(channelId: string, sender: string, text = "hi", parent: string | null = null): TChatMessage {
    this.clock += 1;
    this.ids += 1;
    const at = new Date(Date.UTC(2026, 0, 1) + this.clock * 1000).toISOString();
    const message: TChatMessage = {
      id: `m${String(this.ids).padStart(4, "0")}`,
      workspace: WORKSPACE_ID,
      channel: channelId,
      sender,
      sender_agent: null,
      body_html: `<p>${text}</p>`,
      body_json: {},
      body_stripped: text,
      parent,
      reply_count: 0,
      last_reply_at: null,
      edited_at: null,
      removed_at: null,
      created_at: at,
      updated_at: at,
    };
    this.messages.push(message);
    if (parent) {
      const p = this.messages.find((m) => m.id === parent)!;
      p.reply_count += 1;
      p.last_reply_at = at;
    }
    return message;
  }

  /** The event Django would publish for `message`. */
  createdEvent(message: TChatMessage): TChatEvent {
    return {
      type: "message.created",
      workspace_id: WORKSPACE_ID,
      channel_id: message.channel,
      message_id: message.id,
      ...(message.parent ? { parent_id: message.parent } : {}),
      actor_id: message.sender ?? undefined,
      at: message.created_at,
    };
  }

  private visible(channel: ServerChannel | undefined): channel is ServerChannel {
    return !!channel && (channel.members.has(ME) || channel.kind === "public");
  }

  private channelOr404(channelId: string): ServerChannel {
    const channel = this.channels.get(channelId);
    if (!this.visible(channel)) throw new ChatServiceError(404, { error: "Channel not found." });
    return channel;
  }

  private topLevel(channelId: string) {
    return this.messages.filter((m) => m.channel === channelId && !m.parent);
  }

  payload(channel: ServerChannel): TChatChannel {
    const isMember = channel.members.has(ME);
    const cursor = channel.cursors.get(ME) ?? null;
    const top = this.topLevel(channel.id);
    const cursorIndex = cursor ? top.findIndex((m) => m.id === cursor) : -1;
    const unread = isMember ? top.slice(cursorIndex + 1).filter((m) => m.sender !== ME && !m.removed_at).length : 0;
    return {
      id: channel.id,
      workspace: WORKSPACE_ID,
      kind: channel.kind,
      name: channel.kind === "dm" || channel.kind === "group_dm" ? "" : channel.name,
      description: "",
      project: null,
      archived_at: channel.archived ? "2026-01-02T00:00:00Z" : null,
      created_by: ME,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      is_member: isMember,
      my_role: isMember ? "member" : null,
      last_read_message_id: cursor,
      unread_count: unread,
      last_message_at: top.at(-1)?.created_at ?? null,
      member_count: channel.members.size,
      dm_member_ids: channel.kind === "dm" || channel.kind === "group_dm" ? sortBy([...channel.members]) : [],
    };
  }

  private async held<T>(call: string, answer: T): Promise<T> {
    const hold = this.holds.get(call);
    this.holds.delete(call);
    await hold;
    return answer;
  }

  service(): TChatStoreService {
    const log = (call: string) => this.calls.push(call);
    return {
      me: async () => {
        log("me");
        return {
          workspace_id: WORKSPACE_ID,
          workspace_role: 15,
          is_workspace_admin: false,
          can_create_channels: true,
          can_open_dms: true,
        };
      },
      listChannels: async () => {
        log("listChannels");
        return this.held(
          "listChannels",
          [...this.channels.values()].filter((c) => this.visible(c) && !c.archived).map((c) => this.payload(c))
        );
      },
      getChannel: async (_slug, channelId) => {
        log(`getChannel ${channelId}`);
        return this.payload(this.channelOr404(channelId));
      },
      createChannel: async (_slug, data) => {
        log(`createChannel ${data.name}`);
        const id = `c-${data.name}`;
        this.addChannel(id, { kind: data.kind ?? "public", name: data.name });
        return this.payload(this.channels.get(id)!);
      },
      openDm: async (_slug, memberIds) => {
        const id = `dm-${sortBy([ME, ...memberIds]).join("-")}`;
        log(`openDm ${id}`);
        if (!this.channels.has(id)) this.addChannel(id, { kind: "dm", members: [ME, ...memberIds] });
        return this.payload(this.channels.get(id)!);
      },
      joinChannel: async (_slug, channelId) => {
        log(`join ${channelId}`);
        const channel = this.channelOr404(channelId);
        channel.members.add(ME);
        return this.payload(channel);
      },
      leaveChannel: async (_slug, channelId) => {
        log(`leave ${channelId}`);
        this.channelOr404(channelId).members.delete(ME);
      },
      markRead: async (_slug, channelId, messageId) => {
        log(`markRead ${channelId} ${messageId}`);
        const channel = this.channelOr404(channelId);
        channel.cursors.set(ME, messageId);
        return this.payload(channel);
      },
      listMessages: async (_slug, channelId, query: TChatMessagePageQuery = {}) => {
        log(`listMessages ${channelId} ${JSON.stringify(query)}`);
        this.channelOr404(channelId);
        const top = this.topLevel(channelId);
        const limit = query.limit ?? 50;
        let page: TChatMessage[];
        let hasMore: boolean;
        if (query.after) {
          const start = top.findIndex((m) => m.id === query.after) + 1;
          page = top.slice(start, start + limit);
          hasMore = start + limit < top.length;
        } else {
          const end = query.before ? top.findIndex((m) => m.id === query.before) : top.length;
          page = top.slice(Math.max(0, end - limit), end);
          hasMore = end - limit > 0;
        }
        return this.held("listMessages", clone({ results: page, has_more: hasMore } satisfies TChatMessagePage));
      },
      getMessage: async (_slug, channelId, messageId) => {
        log(`getMessage ${messageId}`);
        this.channelOr404(channelId);
        const message = this.messages.find((m) => m.id === messageId && m.channel === channelId);
        if (!message) throw new ChatServiceError(404, {});
        return this.held("getMessage", clone(message));
      },
      sendMessage: async (_slug, channelId, data) => {
        log(`sendMessage ${channelId}`);
        if (this.failSends) throw new ChatServiceError(0, undefined);
        this.channelOr404(channelId);
        const message = this.post(channelId, ME, data.body_html);
        return clone(message);
      },
      editMessage: async (_slug, _channelId, messageId, data) => {
        log(`editMessage ${messageId}`);
        const message = this.messages.find((m) => m.id === messageId)!;
        message.body_html = data.body_html;
        message.edited_at = "2026-01-03T00:00:00Z";
        return clone(message);
      },
      removeMessage: async (_slug, _channelId, messageId) => {
        log(`removeMessage ${messageId}`);
        const message = this.messages.find((m) => m.id === messageId)!;
        message.body_html = "";
        message.removed_at = "2026-01-03T00:00:00Z";
      },
    };
  }
}

class FakeSocket implements TChatStoreSocket {
  log: string[] = [];
  constructor(readonly handlers: TChatSocketHandlers) {}
  connect() {
    this.log.push("connect");
    this.handlers.onStatusChange?.("connecting", null);
  }
  close() {
    this.log.push("close");
    this.handlers.onStatusChange?.("closed", null);
  }
  subscribe(channelId: string) {
    this.log.push(`subscribe ${channelId}`);
  }
  unsubscribe(channelId: string) {
    this.log.push(`unsubscribe ${channelId}`);
  }
  reconnectNow() {
    this.log.push("reconnectNow");
  }
  noteActivity() {
    this.log.push("noteActivity");
  }
  ready(reconnected = false) {
    this.handlers.onStatusChange?.("ready", null);
    this.handlers.onReady?.({ type: "ready", user_id: ME, workspace_id: WORKSPACE_ID, channels: [] }, reconnected);
  }
  emit(event: TChatEvent) {
    this.handlers.onEvent?.(event);
  }
}

function holdOpen() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Let every pending fetch and its follow-ups finish. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => Array.from({ length: 20 }).reduce<Promise<unknown>>((done) => done.then(tick), Promise.resolve());

async function setup(prepare?: (server: FakeChatServer) => void) {
  const server = new FakeChatServer();
  server.addChannel("c-general");
  server.addChannel("c-random");
  server.addChannel("c-open", { members: [ADA] });
  server.addChannel("c-secret", { kind: "private", members: [ADA] });
  prepare?.(server);
  const sockets: FakeSocket[] = [];
  const store = new ChatStore({
    service: server.service(),
    createSocket: (slug, handlers) => {
      expect(slug).toBe(SLUG);
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
  });
  await store.start(SLUG, ME);
  const socket = sockets[0]!;
  socket.ready();
  await settle();
  server.calls = [];
  return { store, server, socket, sockets };
}

const bodies = (store: ChatStore, channelId: string) =>
  store.getChannelMessages(channelId).map((m) => m.body_stripped || m.body_html);

describe("ChatStore", () => {
  it("loads what the user may do and their channels, and connects", async () => {
    const { store, socket } = await setup();
    expect(socket.log).toEqual(["connect"]);
    expect(store.socketStatus).toBe("ready");
    expect(store.me?.workspace_id).toBe(WORKSPACE_ID);
    expect(store.joinedChannels.map((c) => c.id)).toEqual(["c-general", "c-random"]);
    expect(store.browsableChannels.map((c) => c.id)).toEqual(["c-open"]);
    // A private channel the user isn't in is invisible.
    expect(store.channelMap["c-secret"]).toBeUndefined();
  });

  it("opens a channel at its newest page and marks it read", async () => {
    const { store, server } = await setup((s) => {
      for (let i = 0; i < 60; i++) s.post("c-general", ADA, `m${i}`);
    });
    expect(store.channelMap["c-general"]!.unread_count).toBe(60);
    await store.openChannel("c-general");
    expect(bodies(store, "c-general")).toHaveLength(50);
    expect(bodies(store, "c-general")[49]).toBe("m59");
    expect(store.getMessagesState("c-general")!.hasMoreOlder).toBe(true);
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
    expect(server.calls).toContain(`markRead c-general ${server.messages[59]!.id}`);
    expect(store.totalUnread).toBe(0);
  });

  it("scrolls back with before until there is nothing older", async () => {
    const { store, server } = await setup((s) => {
      for (let i = 0; i < 120; i++) s.post("c-general", ADA, `m${i}`);
    });
    await store.openChannel("c-general");
    await store.loadOlderMessages("c-general");
    expect(bodies(store, "c-general")).toHaveLength(100);
    await store.loadOlderMessages("c-general");
    expect(bodies(store, "c-general")).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
    expect(store.getMessagesState("c-general")!.hasMoreOlder).toBe(false);
    server.calls = [];
    await store.loadOlderMessages("c-general");
    expect(server.calls).toEqual([]);
  });

  it("counts a message in a channel the user isn't looking at, without fetching it", async () => {
    const { store, server, socket } = await setup();
    socket.emit(server.createdEvent(server.post("c-random", ADA)));
    await settle();
    expect(store.channelMap["c-random"]!.unread_count).toBe(1);
    expect(store.totalUnread).toBe(1);
    expect(server.calls).toEqual([]);
  });

  it("appends a message in the open channel and keeps it read", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    server.calls = [];
    const message = server.post("c-general", ADA, "hello");
    socket.emit(server.createdEvent(message));
    await settle();
    expect(bodies(store, "c-general")).toEqual(["hello"]);
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
    expect(server.calls).toEqual([`getMessage ${message.id}`, `markRead c-general ${message.id}`]);
  });

  it("doesn't mark read while the tab is hidden, and does when it comes back", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    store.setDocumentVisible(false);
    socket.emit(server.createdEvent(server.post("c-general", ADA, "while away")));
    await settle();
    expect(bodies(store, "c-general")).toEqual(["while away"]);
    expect(store.channelMap["c-general"]!.unread_count).toBe(1);
    store.setDocumentVisible(true);
    await settle();
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
  });

  it("shows a sent message as pending, then once, and ignores its own event", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    const sending = store.sendMessage("c-general", { body_html: "<p>mine</p>" });
    expect(store.getPendingMessages("c-general").map((p) => p.status)).toEqual(["sending"]);
    await sending;
    expect(store.getPendingMessages("c-general")).toEqual([]);
    const sent = server.messages.at(-1)!;
    server.calls = [];
    socket.emit(server.createdEvent(sent));
    await settle();
    expect(store.getChannelMessages("c-general").map((m) => m.id)).toEqual([sent.id]);
    // Its own message neither counts as unread nor needs fetching.
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
    expect(server.calls).toEqual([]);
  });

  it("doesn't count the user's own message from another tab as unread", async () => {
    const { store, server, socket } = await setup();
    socket.emit(server.createdEvent(server.post("c-random", ME, "from my phone")));
    await settle();
    expect(store.channelMap["c-random"]!.unread_count).toBe(0);
    expect(store.channelMap["c-random"]!.last_message_at).not.toBeNull();
  });

  it("keeps a failed send to retry or discard", async () => {
    const { store, server } = await setup();
    await store.openChannel("c-general");
    server.failSends = true;
    await expect(store.sendMessage("c-general", { body_html: "<p>lost</p>" })).rejects.toThrow();
    const [failed] = store.getPendingMessages("c-general");
    expect(failed!.status).toBe("failed");

    server.failSends = false;
    await store.retryMessage("c-general", failed!.localId);
    expect(store.getPendingMessages("c-general")).toEqual([]);
    expect(bodies(store, "c-general")).toEqual(["<p>lost</p>"]);

    server.failSends = true;
    await expect(store.sendMessage("c-general", { body_html: "<p>again</p>" })).rejects.toThrow();
    store.discardMessage("c-general", store.getPendingMessages("c-general")[0]!.localId);
    expect(store.getPendingMessages("c-general")).toEqual([]);
  });

  it("re-reads an edited or removed message", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-general", ADA, "first"));
    await store.openChannel("c-general");
    const message = server.messages[0]!;
    message.body_stripped = "edited";
    socket.emit({
      type: "message.updated",
      workspace_id: WORKSPACE_ID,
      channel_id: "c-general",
      message_id: message.id,
      at: "t",
    });
    await settle();
    expect(bodies(store, "c-general")).toEqual(["edited"]);

    message.removed_at = "2026-01-03T00:00:00Z";
    socket.emit({
      type: "message.removed",
      workspace_id: WORKSPACE_ID,
      channel_id: "c-general",
      message_id: message.id,
      at: "t",
    });
    await settle();
    expect(store.getChannelMessages("c-general")[0]!.removed_at).not.toBeNull();
  });

  it("updates a parent's reply count on a thread reply, and keeps replies out of the channel", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-general", ADA, "parent"));
    await store.openChannel("c-general");
    const parent = server.messages[0]!;
    socket.emit(server.createdEvent(server.post("c-general", ADA, "reply", parent.id)));
    await settle();
    expect(bodies(store, "c-general")).toEqual(["parent"]);
    expect(store.getChannelMessages("c-general")[0]!.reply_count).toBe(1);
  });

  it("learns about a new DM from the user's own member.added", async () => {
    const { store, server, socket } = await setup();
    server.addChannel("dm-1", { kind: "dm", members: [ME, ADA] });
    socket.emit({ type: "member.added", workspace_id: WORKSPACE_ID, channel_id: "dm-1", user_id: ME, at: "t" });
    await settle();
    expect(store.directMessages.map((c) => c.id)).toEqual(["dm-1"]);
    // Someone else joining a channel the user doesn't know of is none of its business.
    socket.emit({
      type: "member.added",
      workspace_id: WORKSPACE_ID,
      channel_id: "c-secret",
      user_id: "user-bob",
      at: "t",
    });
    await settle();
    expect(store.channelMap["c-secret"]).toBeUndefined();
  });

  it("drops a private channel after the user's own member.removed", async () => {
    const { store, server, socket } = await setup((s) =>
      s.addChannel("c-team", { kind: "private", members: [ME, ADA] })
    );
    await store.openChannel("c-team");
    server.channels.get("c-team")!.members.delete(ME);
    socket.emit({ type: "member.removed", workspace_id: WORKSPACE_ID, channel_id: "c-team", user_id: ME, at: "t" });
    await settle();
    expect(store.channelMap["c-team"]).toBeUndefined();
    expect(store.getChannelMessages("c-team")).toEqual([]);
  });

  it("subscribes to a public channel it is browsing, and again after leaving it", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-open", ADA, "visible"));
    await store.openChannel("c-open");
    expect(socket.log.at(-1)).toBe("subscribe c-open");
    expect(bodies(store, "c-open")).toEqual(["visible"]);
    // Browsing without being a member doesn't move a read cursor.
    expect(server.calls.some((c) => c.startsWith("markRead"))).toBe(false);

    await store.joinChannel("c-open");
    expect(socket.log.at(-1)).toBe("unsubscribe c-open");
    expect(store.joinedChannels.map((c) => c.id)).toContain("c-open");

    await store.leaveChannel("c-open");
    // The gateway stopped following it on member.removed: still on the page, so subscribe again.
    expect(socket.log.at(-1)).toBe("subscribe c-open");
    socket.emit({ type: "member.removed", workspace_id: WORKSPACE_ID, channel_id: "c-open", user_id: ME, at: "t" });
    await settle();
    expect(socket.log.at(-1)).toBe("subscribe c-open");

    store.closeChannel();
    expect(socket.log.at(-1)).toBe("unsubscribe c-open");
  });

  it("catches up after a reconnect by paging after the newest message it has", async () => {
    const { store, server, socket } = await setup((s) => {
      for (let i = 0; i < 3; i++) s.post("c-general", ADA, `before ${i}`);
    });
    await store.openChannel("c-general");
    // While disconnected: 120 new messages, and a new channel.
    for (let i = 0; i < 120; i++) server.post("c-general", ADA, `missed ${i}`);
    server.addChannel("c-new");
    server.calls = [];
    socket.ready(true);
    await settle();

    const shown = bodies(store, "c-general");
    expect(shown).toEqual([
      ...Array.from({ length: 3 }, (_, i) => `before ${i}`),
      ...Array.from({ length: 120 }, (_, i) => `missed ${i}`),
    ]);
    expect(new Set(store.getChannelMessages("c-general").map((m) => m.id)).size).toBe(123);
    // 50 + 50 + 20, until has_more is false.
    expect(server.calls.filter((c) => c.includes('"after"'))).toHaveLength(3);
    expect(store.channelMap["c-new"]).toBeDefined();
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
  });

  it("re-reads the newest page after a reconnect, for edits and removals it missed", async () => {
    const { store, server, socket } = await setup((s) => {
      for (let i = 0; i < 3; i++) s.post("c-general", ADA, `before ${i}`);
    });
    await store.openChannel("c-general");
    server.messages[0]!.body_stripped = "before 0 (edited)";
    server.messages[1]!.removed_at = "2026-01-03T00:00:00Z";
    server.post("c-general", ADA, "missed");
    socket.ready(true);
    await settle();
    expect(bodies(store, "c-general")).toEqual(["before 0 (edited)", "before 1", "before 2", "missed"]);
    expect(store.getChannelMessages("c-general")[1]!.removed_at).not.toBeNull();
  });

  it("does the same on a resync frame", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    server.post("c-general", ADA, "dropped event");
    socket.handlers.onResync?.("events_missed");
    await settle();
    expect(bodies(store, "c-general")).toEqual(["dropped event"]);
  });

  it("reports a socket that must not retry", async () => {
    const { store, socket } = await setup();
    socket.handlers.onStatusChange?.("closed", "unauthenticated");
    expect(store.socketStatus).toBe("closed");
    expect(store.socketClosedReason).toBe("unauthenticated");
  });

  it("forgets everything on stop, and ignores answers for the old workspace", async () => {
    const server = new FakeChatServer();
    server.addChannel("c-general");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = server.service();
    const slowList = vi.fn(async (...args: Parameters<TChatStoreService["listChannels"]>) => {
      await gate;
      return service.listChannels(...args);
    });
    const sockets: FakeSocket[] = [];
    const store = new ChatStore({
      service: { ...service, listChannels: slowList },
      createSocket: (_slug, handlers) => {
        const socket = new FakeSocket(handlers);
        sockets.push(socket);
        return socket;
      },
    });
    const starting = store.start(SLUG, ME);
    store.stop();
    expect(sockets[0]!.log).toEqual(["connect", "close"]);
    release();
    await starting;
    expect(store.channelMap).toEqual({});
    expect(store.workspaceSlug).toBeNull();
  });

  it("counts sending as activity, so a message wakes an idle socket", async () => {
    const { store, socket } = await setup();
    socket.log = [];
    await store.sendMessage("c-general", { body_html: "<p>back</p>" });
    expect(socket.log).toContain("noteActivity");
  });

  it("counts a retry as activity", async () => {
    const { store, socket, server } = await setup();
    server.failSends = true;
    await expect(store.sendMessage("c-general", { body_html: "<p>lost</p>" })).rejects.toThrow();
    server.failSends = false;
    socket.log = [];
    const localId = store.pendingMessages["c-general"]![0]!.localId;
    await store.retryMessage("c-general", localId);
    expect(socket.log).toContain("noteActivity");
  });

  it("forwards activity to the socket, and does nothing once stopped", async () => {
    const { store, socket } = await setup();
    socket.log = [];
    store.noteActivity();
    expect(socket.log).toEqual(["noteActivity"]);
    store.stop();
    socket.log = [];
    expect(() => store.noteActivity()).not.toThrow();
    expect(socket.log).toEqual([]);
  });

  it("catches up when an idle socket comes back", async () => {
    const { store, socket, server } = await setup((s) => {
      s.post("c-general", ADA, "before");
    });
    await store.openChannel("c-general");
    socket.handlers.onStatusChange?.("paused", null);
    expect(store.socketStatus).toBe("paused");
    server.post("c-general", ADA, "missed");
    server.calls = [];
    socket.ready(true);
    await settle();
    expect(server.calls).toContain("listChannels");
    expect(bodies(store, "c-general")).toEqual(["before", "missed"]);
  });

  it("doesn't skip what it missed when a send lands before the idle socket is back", async () => {
    const { store, socket, server } = await setup((s) => {
      for (let i = 0; i < 3; i++) s.post("c-general", ADA, `before ${i}`);
    });
    await store.openChannel("c-general");
    socket.handlers.onStatusChange?.("paused", null);
    // More than the newest-page re-read can repair.
    for (let i = 0; i < 120; i++) server.post("c-general", ADA, `missed ${i}`);
    await store.sendMessage("c-general", { body_html: "<p>mine</p>" });

    socket.ready(true);
    await settle();

    const shown = bodies(store, "c-general");
    expect(shown).toHaveLength(124);
    expect(shown.slice(0, 123)).toEqual([
      ...Array.from({ length: 3 }, (_, i) => `before ${i}`),
      ...Array.from({ length: 120 }, (_, i) => `missed ${i}`),
    ]);
  });

  describe("revealMessage", () => {
    /** 120 messages oldest to newest, so the first page (50) doesn't reach the oldest. */
    function withHistory(server: FakeChatServer) {
      for (let index = 0; index < 120; index += 1) server.post("c-general", ADA);
    }

    it("is already there when the message is on the loaded page", async () => {
      const { store, server } = await setup(withHistory);
      await store.openChannel("c-general");
      server.calls = [];
      await expect(store.revealMessage("c-general", "m0120")).resolves.toBe(true);
      expect(server.calls.filter((call) => call.startsWith("listMessages"))).toEqual([]);
    });

    it("loads back until the message is there, and stops", async () => {
      const { store, server } = await setup(withHistory);
      await store.openChannel("c-general");
      server.calls = [];
      await expect(store.revealMessage("c-general", "m0010")).resolves.toBe(true);
      expect(server.calls.filter((call) => call.startsWith("listMessages"))).toHaveLength(2);
      expect(store.getChannelMessages("c-general").map((message) => message.id)).toContain("m0010");
    });

    it("says so when the message isn't in the channel", async () => {
      const { store } = await setup(withHistory);
      await store.openChannel("c-general");
      await expect(store.revealMessage("c-general", "nope")).resolves.toBe(false);
    });

    it("waits for a page already on its way instead of giving up", async () => {
      const { store } = await setup(withHistory);
      await store.openChannel("c-general");
      void store.loadOlderMessages("c-general");
      await expect(store.revealMessage("c-general", "m0010")).resolves.toBe(true);
    });
  });

  it("keeps its actions bound, so components can destructure them", async () => {
    const { store } = await setup();
    const { createChannel, openDm, markRead } = store;
    await expect(createChannel({ name: "bound" })).resolves.toMatchObject({ id: "c-bound" });
    await expect(openDm([ADA])).resolves.toMatchObject({ kind: "dm" });
    await expect(markRead("c-bound")).resolves.toBeUndefined();
  });

  it("creates channels and opens DMs over REST", async () => {
    const { store } = await setup();
    const channel = await store.createChannel({ name: "launch", kind: "private" });
    expect(store.joinedChannels.map((c) => c.id)).toContain(channel.id);
    const dm = await store.openDm([ADA]);
    expect(store.directMessages.map((c) => c.id)).toEqual([dm.id]);
  });

  it("keeps an archived channel open, and drops one that is gone", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    server.channels.get("c-general")!.archived = true;
    socket.emit({ type: "channel.archived", workspace_id: WORKSPACE_ID, channel_id: "c-general", at: "t" });
    await settle();
    expect(store.activeChannel?.archived_at).toBe("2026-01-02T00:00:00Z");
    expect(store.joinedChannels.map((c) => c.id)).toEqual(["c-random"]);

    // A reconnect's list has no archived channels: the open one is re-read, not dropped.
    socket.ready(true);
    await settle();
    expect(store.activeChannel?.archived_at).toBe("2026-01-02T00:00:00Z");

    server.channels.delete("c-general");
    socket.ready(true);
    await settle();
    expect(store.activeChannel).toBeUndefined();
  });

  it("pages from where history stopped, not from a live message that got in first", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-general", ADA, "before"));
    await store.openChannel("c-general");
    for (let i = 0; i < 120; i++) server.post("c-general", ADA, `missed${i}`);
    const list = holdOpen();
    server.holds.set("listChannels", list.opened);
    socket.ready(true);
    await settle();
    socket.emit(server.createdEvent(server.post("c-general", ADA, "live")));
    await settle();
    list.open();
    await settle();
    expect(bodies(store, "c-general")).toHaveLength(122);
    expect(bodies(store, "c-general")[1]).toBe("missed0");
  });

  it("resumes a failed catch-up from where it stopped, even after a live message", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-general", ADA, "before"));
    await store.openChannel("c-general");
    for (let i = 0; i < 120; i++) server.post("c-general", ADA, `missed${i}`);
    server.holds.set("listMessages", Promise.reject(new ChatServiceError(0, undefined)));
    socket.ready(true);
    await settle();
    socket.emit(server.createdEvent(server.post("c-general", ADA, "live")));
    await settle();
    socket.ready(true);
    await settle();
    expect(bodies(store, "c-general")).toHaveLength(122);
  });

  it("reloads a channel that was empty when events stopped, so older history stays reachable", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    for (let i = 0; i < 60; i++) server.post("c-general", ADA, `m${i}`);
    socket.ready(true);
    await settle();
    expect(bodies(store, "c-general")).toHaveLength(50);
    expect(store.getMessagesState("c-general")!.hasMoreOlder).toBe(true);
  });

  it("doesn't lose a message that arrives while the channel is loading", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-general", ADA, "first"));
    const load = holdOpen();
    server.holds.set("listMessages", load.opened);
    void store.openChannel("c-general");
    await settle();
    socket.emit(server.createdEvent(server.post("c-general", ADA, "during")));
    await settle();
    load.open();
    await settle();
    expect(bodies(store, "c-general")).toEqual(["first", "during"]);
  });

  it("keeps a channel that appears while the channel list is in flight", async () => {
    const { store, server } = await setup();
    const list = holdOpen();
    server.holds.set("listChannels", list.opened);
    void store.fetchChannels();
    await settle();
    await store.createChannel({ name: "new" });
    list.open();
    await settle();
    expect(store.channelMap["c-new"]).toBeDefined();
  });

  it("ignores an older copy of a message that answers late", async () => {
    const { store, server, socket } = await setup((s) => s.post("c-general", ADA, "first"));
    await store.openChannel("c-general");
    const message = server.messages[0]!;
    const event = { workspace_id: WORKSPACE_ID, channel_id: "c-general", message_id: message.id, at: "t" };
    const slow = holdOpen();
    server.holds.set("getMessage", slow.opened);
    socket.emit({ type: "message.updated", ...event });
    await settle();
    message.removed_at = "2026-01-03T00:00:00Z";
    message.updated_at = "2026-01-03T00:00:00Z";
    socket.emit({ type: "message.removed", ...event });
    await settle();
    slow.open();
    await settle();
    expect(store.getChannelMessages("c-general")[0]!.removed_at).not.toBeNull();
  });

  it("forgets the messages of a channel the user left while looking elsewhere", async () => {
    const { store } = await setup((s) => s.post("c-general", ADA, "first"));
    await store.openChannel("c-general");
    store.closeChannel();
    await store.leaveChannel("c-general");
    expect(store.channelMap["c-general"]!.is_member).toBe(false);
    expect(store.getMessagesState("c-general")).toBeUndefined();
  });

  it("drops a load that lands after a browsed channel was closed", async () => {
    const { store, server } = await setup((s) => s.post("c-open", ADA, "first"));
    const load = holdOpen();
    server.holds.set("listMessages", load.opened);
    void store.openChannel("c-open");
    await settle();
    store.closeChannel();
    load.open();
    await settle();
    expect(store.getMessagesState("c-open")).toBeUndefined();
  });

  it("orders by the moment, whatever UTC offset a timestamp is written in", async () => {
    const { store } = await setup((s) => {
      s.addChannel("dm-earlier", { kind: "dm", members: [ME, ADA] });
      s.addChannel("dm-later", { kind: "dm", members: [ME, "user-bob"] });
      s.post("dm-earlier", ADA).created_at = "2026-01-01T02:00:00+03:00";
      s.post("dm-later", "user-bob").created_at = "2026-01-01T00:30:00Z";
    });
    expect(store.directMessages.map((c) => c.id)).toEqual(["dm-later", "dm-earlier"]);
  });
});
