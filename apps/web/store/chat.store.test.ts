/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { orderBy, sortBy } from "lodash-es";
import { describe, expect, it, vi } from "vitest";
import { ChatServiceError } from "@plane/services";
import type { TChatSocketHandlers } from "@plane/services";
import type {
  TAgentPermissionLevel,
  TChatAgentDm,
  TChatAgentPermissionRequest,
  TChatChannel,
  TChatChannelAgent,
  TChatChannelKind,
  TChatEvent,
  TChatMessage,
  TChatMessagePage,
  TChatMessagePageQuery,
  TChatSearchPage,
  TChatSearchQuery,
  TChatWorkItemLink,
  TWorkspaceAgent,
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
  project: string | null;
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
  /** What a failed send throws. */
  sendFailure = new ChatServiceError(0, undefined);
  sentAttachmentIds: (string[] | undefined)[] = [];
  /** Holds the next answer of a call back until the promise resolves. The answer is read when the call arrives. */
  holds = new Map<string, Promise<void>>();
  nextLink: TChatWorkItemLink | undefined;
  /** By channel. */
  agents = new Map<string, TChatChannelAgent[]>();
  registry: TWorkspaceAgent[] = [];
  /** What removing an agent throws instead, if set. */
  removeAgentFailure: ChatServiceError | undefined;
  /** What `me` says: a guest may not mention agents. */
  canMentionAgents = true;
  /** Agent DMs by channel: their agent and state. */
  agentDms = new Map<string, Omit<TChatAgentDm, "agent"> & { agentId: string | null }>();
  /** Pending permission prompts by agent DM. */
  permissions = new Map<string, TChatAgentPermissionRequest[]>();
  /** What answering a permission prompt or stopping a turn throws instead, if set. */
  answerFailure: ChatServiceError | undefined;
  stopFailure: ChatServiceError | undefined;
  private clock = 0;
  private ids = 0;

  addChannel(id: string, options: { kind?: TChatChannelKind; members?: string[]; name?: string } = {}) {
    this.channels.set(id, {
      id,
      kind: options.kind ?? "public",
      name: options.name ?? id,
      members: new Set(options.members ?? [ME]),
      archived: false,
      project: null,
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
      sender_agent_details: null,
      system_event: null,
      agent_notice: null,
      agent_streaming: false,
      agent_tool_calls: null,
      body_html: `<p>${text}</p>`,
      body_json: {},
      body_stripped: text,
      parent,
      reply_count: 0,
      last_reply_at: null,
      references: [],
      attachments: [],
      attachment_count: 0,
      edited_at: null,
      removed_at: null,
      created_at: at,
      updated_at: at,
    };
    this.messages.push(message);
    if (parent) this.summarize(parent);
    return message;
  }

  /** A thread's summary counts its replies that aren't removed, as the API's does. */
  summarize(parentId: string) {
    const parent = this.messages.find((m) => m.id === parentId)!;
    const live = this.messages.filter((m) => m.parent === parentId && !m.removed_at);
    parent.reply_count = live.length;
    parent.last_reply_at = live.at(-1)?.created_at ?? null;
  }

  /** Remove a message the way the API does: a tombstone that stays in its list. */
  remove(messageId: string) {
    const message = this.messages.find((m) => m.id === messageId)!;
    message.body_html = "";
    message.body_stripped = "";
    message.removed_at = "2026-01-03T00:00:00Z";
    if (message.parent) this.summarize(message.parent);
    return message;
  }

  /** The `message.updated` or `message.removed` event Django would publish for `message`. */
  changedEvent(type: "message.updated" | "message.removed", message: TChatMessage): TChatEvent {
    return { ...this.createdEvent(message), type, actor_id: ADA };
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

  /** One keyset page of `list`, as the API's `paginate_messages` gives it. */
  private page(list: TChatMessage[], query: TChatMessagePageQuery): TChatMessagePage {
    const limit = query.limit ?? 50;
    if (query.after) {
      const start = list.findIndex((m) => m.id === query.after) + 1;
      return { results: list.slice(start, start + limit), has_more: start + limit < list.length };
    }
    const end = query.before ? list.findIndex((m) => m.id === query.before) : list.length;
    return { results: list.slice(Math.max(0, end - limit), end), has_more: end - limit > 0 };
  }

  /** The API's search, as far as the store can tell: matches in readable channels, newest first, `before` paging. */
  search(query: TChatSearchQuery): TChatSearchPage {
    const matches = orderBy(
      this.messages
        .filter((m) => this.visible(this.channels.get(m.channel)) && !m.removed_at && m.body_stripped.includes(query.q))
        .filter((m) => !query.channel || m.channel === query.channel)
        .filter((m) => !query.sender || m.sender === query.sender)
        .filter((m) => query.automatic !== false || !m.system_event),
      ["created_at", "id"],
      ["desc", "desc"]
    );
    const start = query.before ? matches.findIndex((m) => m.id === query.before) + 1 : 0;
    const limit = query.limit ?? 20;
    return {
      results: matches.slice(start, start + limit).map((m) => {
        const { id, kind, name, archived_at, is_member, dm_member_ids } = this.payload(this.channels.get(m.channel)!);
        return {
          message: m,
          channel: { id, kind, name, archived_at, is_member, dm_member_ids, agent_dm: null },
          snippet: [{ text: m.body_stripped, match: true }],
        };
      }),
      has_more: start + limit < matches.length,
    };
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
      project: channel.project,
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
      dm_member_ids:
        channel.kind === "dm" || channel.kind === "group_dm" || channel.kind === "agent_dm"
          ? sortBy([...channel.members])
          : [],
      agent_dm: this.agentDmPayload(channel.id),
    };
  }

  agentDmPayload(channelId: string): TChatAgentDm | null {
    const dm = this.agentDms.get(channelId);
    if (!dm) return null;
    const { agentId, ...rest } = dm;
    const agent = this.registry.find((a) => a.id === agentId);
    return {
      ...rest,
      agent: agent
        ? { id: agent.id, slug: agent.slug, name: agent.name, adapter: agent.adapter, is_available: true }
        : null,
    };
  }

  addAgentDm(channelId: string, agentId: string, state: Partial<Omit<TChatAgentDm, "agent">> = {}) {
    this.addChannel(channelId, { kind: "agent_dm", name: "" });
    this.agentDms.set(channelId, {
      agentId,
      permission_level: "ask_writes",
      default_permission_level: "ask_writes",
      max_permission_level: "yolo",
      responding: false,
      read_only_reason: null,
      ...state,
    });
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
          can_add_agents: true,
          can_mention_agents: this.canMentionAgents,
          agent_reply_timeout_seconds: 300,
          can_open_agent_dms: this.canMentionAgents,
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
      updateChannel: async (_slug, channelId, data) => {
        log(`updateChannel ${channelId}`);
        const channel = this.channelOr404(channelId);
        if (data.project !== undefined) channel.project = data.project;
        return this.payload(channel);
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
        return this.held("listMessages", clone(this.page(this.topLevel(channelId), query)));
      },
      listReplies: async (_slug, channelId, parentId, query: TChatMessagePageQuery = {}) => {
        log(`listReplies ${parentId} ${JSON.stringify(query)}`);
        this.channelOr404(channelId);
        if (!this.messages.some((m) => m.id === parentId && m.channel === channelId && !m.parent)) {
          throw new ChatServiceError(404, {});
        }
        const replies = this.messages.filter((m) => m.parent === parentId);
        return this.held("listReplies", clone(this.page(replies, query)));
      },
      searchMessages: async (_slug, query: TChatSearchQuery) => {
        log(`searchMessages ${JSON.stringify(query)}`);
        return this.held("searchMessages", clone(this.search(query)));
      },
      getMessage: async (_slug, channelId, messageId) => {
        log(`getMessage ${messageId}`);
        this.channelOr404(channelId);
        const message = this.messages.find((m) => m.id === messageId && m.channel === channelId);
        if (!message) throw new ChatServiceError(404, {});
        return this.held("getMessage", clone(message));
      },
      linkWorkItem: async (_slug, channelId, messageId, issueId) => {
        log(`linkWorkItem ${channelId} ${messageId} ${issueId}`);
        if (!this.nextLink) throw new ChatServiceError(404, undefined);
        return this.nextLink;
      },
      sendMessage: async (_slug, channelId, data) => {
        log(`sendMessage ${channelId}`);
        this.sentAttachmentIds.push(data.attachment_ids);
        if (this.failSends) throw this.sendFailure;
        this.channelOr404(channelId);
        const message = this.post(channelId, ME, data.body_html, data.parent_id ?? null);
        return this.held("sendMessage", clone(message));
      },
      uploadAttachment: async (_slug, channelId, file) => {
        log(`uploadAttachment ${channelId} ${file.name}`);
        return { id: `asset-${file.name}`, name: file.name, type: file.type, size: file.size };
      },
      deleteAttachment: async (_slug, _channelId, attachmentId) => {
        log(`deleteAttachment ${attachmentId}`);
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
        this.remove(messageId);
      },
      listMembers: async (_slug, channelId) => {
        log(`listMembers ${channelId}`);
        return [...this.channelOr404(channelId).members].map((user) => ({
          id: `m-${user}`,
          channel: channelId,
          user,
          role: "member" as const,
          created_at: "2026-01-01T00:00:00Z",
        }));
      },
      addMembers: async (_slug, channelId, memberIds) => {
        log(`addMembers ${channelId} ${memberIds.join(",")}`);
        const channel = this.channelOr404(channelId);
        const added = memberIds.filter((user) => !channel.members.has(user));
        for (const user of added) channel.members.add(user);
        return added.map((user) => ({
          id: `m-${user}`,
          channel: channelId,
          user,
          role: "member" as const,
          created_at: "2026-01-01T00:00:00Z",
        }));
      },
      removeMember: async (_slug, channelId, userId) => {
        log(`removeMember ${channelId} ${userId}`);
        const channel = this.channelOr404(channelId);
        if (!channel.members.delete(userId)) throw new ChatServiceError(404, {});
      },
      listAgents: async (_slug, channelId) => {
        log(`listAgents ${channelId}`);
        this.channelOr404(channelId);
        return this.held("listAgents", clone(this.agents.get(channelId) ?? []));
      },
      addAgent: async (_slug, channelId, data) => {
        log(`addAgent ${channelId} ${data.agent_id} ${data.permission_level}`);
        this.channelOr404(channelId);
        const held = this.agents.get(channelId) ?? [];
        const existing = held.find((agent) => agent.agent === data.agent_id);
        if (existing) return clone(existing);
        const added = channelAgent(channelId, data.agent_id, data.permission_level);
        this.agents.set(channelId, [...held, added]);
        return clone(added);
      },
      removeAgent: async (_slug, channelId, agentId) => {
        log(`removeAgent ${channelId} ${agentId}`);
        if (this.removeAgentFailure) throw this.removeAgentFailure;
        const held = this.agents.get(channelId) ?? [];
        if (!held.some((agent) => agent.agent === agentId)) throw new ChatServiceError(404, {});
        this.agents.set(
          channelId,
          held.filter((agent) => agent.agent !== agentId)
        );
      },
      listAvailableAgents: async () => {
        log("listAvailableAgents");
        return clone(this.registry);
      },
      openAgentDm: async (_slug, agentId) => {
        const id = `adm-${agentId}`;
        log(`openAgentDm ${agentId}`);
        if (!this.channels.has(id)) this.addAgentDm(id, agentId);
        return this.payload(this.channels.get(id)!);
      },
      setAgentDmLevel: async (_slug, channelId, level: TAgentPermissionLevel) => {
        log(`setAgentDmLevel ${channelId} ${level}`);
        this.agentDms.get(channelId)!.permission_level = level;
        return this.payload(this.channelOr404(channelId));
      },
      stopAgentTurn: async (_slug, channelId) => {
        log(`stopAgentTurn ${channelId}`);
        if (this.stopFailure) throw this.stopFailure;
        this.agentDms.get(channelId)!.responding = false;
      },
      listAgentPermissions: async (_slug, channelId) => {
        log(`listAgentPermissions ${channelId}`);
        this.channelOr404(channelId);
        return clone(this.permissions.get(channelId) ?? []);
      },
      answerAgentPermission: async (_slug, channelId, requestId, optionId) => {
        log(`answerAgentPermission ${channelId} ${requestId} ${optionId}`);
        const pending = this.permissions.get(channelId) ?? [];
        this.permissions.set(
          channelId,
          pending.filter((request) => request.id !== requestId)
        );
        if (this.answerFailure) throw this.answerFailure;
      },
    };
  }
}

function channelAgent(
  channelId: string,
  agentId: string,
  level: TChatChannelAgent["permission_level"] = "ask_writes"
): TChatChannelAgent {
  return {
    id: `seat-${channelId}-${agentId}`,
    channel: channelId,
    agent: agentId,
    slug: agentId,
    name: `Agent ${agentId}`,
    description: "",
    adapter: "claude",
    permission_level: level,
    is_available: true,
    added_by: ME,
    added_at: "2026-01-01T00:00:00Z",
  };
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

  it("doesn't mark read while the list is scrolled up, and does when it is back at the bottom", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    store.setAtNewest("c-general", false);
    socket.emit(server.createdEvent(server.post("c-general", ADA, "while reading older")));
    await settle();
    expect(bodies(store, "c-general")).toEqual(["while reading older"]);
    expect(store.channelMap["c-general"]!.unread_count).toBe(1);
    // Coming back to the tab, or a reconnect, isn't seeing the newest messages either.
    store.setDocumentVisible(false);
    store.setDocumentVisible(true);
    socket.ready(true);
    await settle();
    expect(server.calls.filter((call) => call.startsWith("markRead"))).toEqual([]);
    expect(store.channelMap["c-general"]!.unread_count).toBe(1);

    store.setAtNewest("c-general", true);
    await settle();
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
  });

  it("keeps an unsent draft per channel until it is cleared or the workspace changes", async () => {
    const { store } = await setup();
    store.setDraft("c-general", "<p>half written</p>");
    store.setDraft("c-random", "<p>other</p>");
    await store.openChannel("c-random");
    await store.openChannel("c-general");
    expect(store.getDraft("c-general")).toBe("<p>half written</p>");
    expect(store.getDraft("c-random")).toBe("<p>other</p>");
    store.setDraft("c-general", "");
    expect(store.getDraft("c-general")).toBeUndefined();
    store.stop();
    expect(store.getDraft("c-random")).toBeUndefined();
  });

  it("starts the next channel at the bottom, and ignores a list that isn't the open one", async () => {
    const { store, server, socket } = await setup();
    await store.openChannel("c-general");
    store.setAtNewest("c-general", false);
    await store.openChannel("c-random");
    expect(store.isAtNewest).toBe(true);
    store.setAtNewest("c-general", false);
    expect(store.isAtNewest).toBe(true);
    socket.emit(server.createdEvent(server.post("c-random", ADA)));
    await settle();
    expect(store.channelMap["c-random"]!.unread_count).toBe(0);
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

  it("keeps a send refused for going too fast, says so, and sends it on a retry", async () => {
    const { store, server } = await setup();
    await store.openChannel("c-general");
    server.failSends = true;
    await expect(store.sendMessage("c-general", { body_html: "<p>first</p>" })).rejects.toThrow();
    expect(store.getPendingMessages("c-general")[0]).toMatchObject({ status: "failed", rateLimited: false });

    server.sendFailure = new ChatServiceError(429, { error: "Too many requests." }, 7);
    await expect(store.sendMessage("c-general", { body_html: "<p>pasted</p>" })).rejects.toThrow();
    const [, limited] = store.getPendingMessages("c-general");
    expect(limited).toMatchObject({ status: "failed", rateLimited: true, body_html: "<p>pasted</p>" });

    server.failSends = false;
    await store.retryMessage("c-general", limited!.localId);
    expect(store.getPendingMessages("c-general").map((p) => p.body_html)).toEqual(["<p>first</p>"]);
    expect(bodies(store, "c-general")).toEqual(["<p>pasted</p>"]);
  });

  it("sends finished uploads by ID and keeps them across a failed send, without uploading again", async () => {
    const { store, server } = await setup();
    await store.openChannel("c-general");
    const files = [{ id: "asset-1", name: "a.png", type: "image/png", size: 10 }];

    server.failSends = true;
    await expect(
      store.sendMessage("c-general", { body_html: "<p></p>", body_json: {}, attachments: files })
    ).rejects.toThrow();
    const [failed] = store.getPendingMessages("c-general");
    expect(failed!.attachments).toEqual(files);

    server.failSends = false;
    await store.retryMessage("c-general", failed!.localId);
    expect(store.getPendingMessages("c-general")).toEqual([]);
    expect(server.sentAttachmentIds).toEqual([["asset-1"], ["asset-1"]]);
    expect(server.calls.filter((call) => call.startsWith("uploadAttachment"))).toEqual([]);
  });

  it("sends no attachment_ids for a message without files", async () => {
    const { store, server } = await setup();
    await store.openChannel("c-general");
    await store.sendMessage("c-general", { body_html: "<p>hi</p>", body_json: {} });
    expect(server.sentAttachmentIds).toEqual([undefined]);
  });

  it("gives up the uploads of a discarded message, and only those", async () => {
    const { store, server } = await setup();
    await store.openChannel("c-general");
    server.failSends = true;
    await expect(
      store.sendMessage("c-general", {
        body_html: "<p></p>",
        body_json: {},
        attachments: [{ id: "asset-1", name: "a.png", type: "image/png", size: 10 }],
      })
    ).rejects.toThrow();
    store.discardMessage("c-general", store.getPendingMessages("c-general")[0]!.localId);
    expect(server.calls).toContain("deleteAttachment asset-1");

    server.failSends = false;
    server.calls = [];
    await store.sendMessage("c-general", {
      body_html: "<p></p>",
      body_json: {},
      attachments: [{ id: "asset-2", name: "b.png", type: "image/png", size: 10 }],
    });
    expect(server.calls.filter((call) => call.startsWith("deleteAttachment"))).toEqual([]);
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

  describe("linkWorkItem", () => {
    it("shows the updated message, and the note in its thread rather than the channel", async () => {
      const { store, server } = await setup();
      const original = server.post("c-general", ADA, "login is broken");
      await store.openChannel("c-general");
      await store.openThread("c-general", original.id);
      const reference = { id: "i1", project: "p1", key: "EMP-1", name: "x", priority: "high" as const, state: null };
      const reply = server.post("c-general", ME, "Created EMP-1", original.id);
      server.nextLink = { message: { ...clone(original), references: [reference] }, reply: clone(reply) };
      await store.linkWorkItem("c-general", original.id, "i1");
      expect(server.calls).toContain(`linkWorkItem c-general ${original.id} i1`);
      expect(store.messageMap[original.id]?.references).toEqual([reference]);
      expect(store.messageMap[original.id]?.reply_count).toBe(1);
      expect(store.getChannelMessages("c-general").map((message) => message.id)).toEqual([original.id]);
      expect(store.getThreadReplies(original.id).map((message) => message.id)).toEqual([reply.id]);
    });

    it("puts the note for a reply in that reply's thread, and re-reads the thread's summary", async () => {
      const { store, server } = await setup();
      const original = server.post("c-general", ADA, "login is broken");
      const report = server.post("c-general", ADA, "still broken", original.id);
      await store.openChannel("c-general");
      await store.openThread("c-general", original.id);
      const note = server.post("c-general", ME, "Created EMP-1", original.id);
      server.nextLink = { message: clone(report), reply: clone(note) };
      server.calls = [];
      await store.linkWorkItem("c-general", report.id, "i1");
      expect(store.getThreadReplies(original.id).map((message) => message.id)).toEqual([report.id, note.id]);
      expect(server.calls).toContain(`getMessage ${original.id}`);
      expect(store.messageMap[original.id]?.reply_count).toBe(2);
    });

    it("adds no note when it was already linked", async () => {
      const { store, server } = await setup();
      const original = server.post("c-general", ADA);
      await store.openChannel("c-general");
      server.nextLink = { message: original, reply: null };
      await store.linkWorkItem("c-general", original.id, "i1");
      expect(store.getChannelMessages("c-general")).toHaveLength(1);
    });

    it("lets the caller know it failed", async () => {
      const { store, server } = await setup();
      const original = server.post("c-general", ADA);
      await store.openChannel("c-general");
      server.nextLink = undefined;
      await expect(store.linkWorkItem("c-general", original.id, "i1")).rejects.toThrow();
    });
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

    it("stops at a page that fails, instead of asking again", async () => {
      const { store, server } = await setup(withHistory);
      await store.openChannel("c-general");
      server.holds.set("listMessages", Promise.reject(new ChatServiceError(0, undefined)));
      server.calls = [];
      await expect(store.revealMessage("c-general", "m0010")).resolves.toBe(false);
      expect(server.calls.filter((call) => call.startsWith("listMessages"))).toHaveLength(1);
    });

    it("keeps the page on its way when one from before a restart lands", async () => {
      const { store, server } = await setup(withHistory);
      await store.openChannel("c-general");
      let releaseOld!: () => void;
      server.holds.set("listMessages", new Promise<void>((resolve) => (releaseOld = resolve)));
      void store.loadOlderMessages("c-general");
      const slug = store.workspaceSlug!;
      store.stop();
      await store.start(slug, ME);
      await settle();
      await store.openChannel("c-general");
      let releaseNew!: () => void;
      server.holds.set("listMessages", new Promise<void>((resolve) => (releaseNew = resolve)));
      const running = store.loadOlderMessages("c-general");
      releaseOld();
      await settle();
      expect(store.loadOlderMessages("c-general")).toBe(running);
      releaseNew();
      await running;
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

  it("links a channel to a project and unlinks it", async () => {
    const { store } = await setup();
    const { updateChannel } = store;
    await expect(updateChannel("c-general", { project: "p-1" })).resolves.toMatchObject({ project: "p-1" });
    expect(store.channelMap["c-general"]?.project).toBe("p-1");
    await updateChannel("c-general", { project: null });
    expect(store.channelMap["c-general"]?.project).toBeNull();
  });

  it("counts an automatic message, which has no actor, as unread", async () => {
    const { store, server, socket } = await setup();
    const before = store.channelMap["c-random"]!.unread_count;
    const posted = server.post("c-random", ADA, "EMP-1 moved to Done");
    const message = { ...posted, sender: null, system_event: "work_item_state" as const };
    server.messages[server.messages.length - 1] = message;
    // Posted by a job, so its event has no actor.
    const event = server.createdEvent(message);
    expect(event.actor_id).toBeUndefined();
    socket.emit(event);
    await settle();
    expect(store.channelMap["c-random"]!.unread_count).toBe(before + 1);
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

const replies = (store: ChatStore, parentId: string) =>
  store.getThreadReplies(parentId).map((m) => m.body_stripped || m.body_html);

describe("ChatStore threads", () => {
  /** A parent in c-general with `count` replies from Ada, the channel open. */
  async function withThread(count: number, prepare?: (server: FakeChatServer) => void) {
    const env = await setup((s) => {
      const parent = s.post("c-general", ADA, "parent");
      for (let i = 0; i < count; i++) s.post("c-general", ADA, `r${i}`, parent.id);
      prepare?.(s);
    });
    await env.store.openChannel("c-general");
    const parent = env.server.messages[0]!;
    return { ...env, parent };
  }

  it("opens on the newest page of replies, oldest first, and scrolls back", async () => {
    const { store, parent } = await withThread(60);
    await store.openThread("c-general", parent.id);
    expect(store.activeThread).toEqual({ channelId: "c-general", parentId: parent.id });
    expect(replies(store, parent.id)).toEqual(Array.from({ length: 50 }, (_, i) => `r${i + 10}`));
    expect(store.getThreadState(parent.id)!.hasMoreOlder).toBe(true);
    await store.loadOlderReplies(parent.id);
    expect(replies(store, parent.id)).toEqual(Array.from({ length: 60 }, (_, i) => `r${i}`));
    expect(store.getThreadState(parent.id)!.hasMoreOlder).toBe(false);
    // Replies never join the channel's list.
    expect(bodies(store, "c-general")).toEqual(["parent"]);
  });

  it("fetches the thread's first message when the channel's list doesn't hold it", async () => {
    const { store, server } = await setup((s) => {
      const old = s.post("c-general", ADA, "old parent");
      s.post("c-general", ADA, "reply", old.id);
      for (let i = 0; i < 60; i++) s.post("c-general", ADA, `m${i}`);
    });
    await store.openChannel("c-general");
    const parent = server.messages[0]!;
    expect(store.messageMap[parent.id]).toBeUndefined();
    await store.openThread("c-general", parent.id);
    expect(store.messageMap[parent.id]?.body_stripped).toBe("old parent");
    expect(replies(store, parent.id)).toEqual(["reply"]);
    // Closing forgets it again: the channel's list never held it.
    store.closeThread();
    expect(store.messageMap[parent.id]).toBeUndefined();
  });

  it("keeps a first message older than the loaded pages out of the channel's list, so scrolling back skips nothing", async () => {
    const { store, server } = await setup((s) => {
      const old = s.post("c-general", ADA, "old parent");
      s.post("c-general", ADA, "reply", old.id);
      for (let i = 0; i < 60; i++) s.post("c-general", ADA, `m${i}`);
    });
    await store.openChannel("c-general");
    const parent = server.messages[0]!;
    await store.openThread("c-general", parent.id);
    // Removing it from the thread panel re-reads it, as does linking a work item to it.
    await store.removeMessage("c-general", parent.id);
    expect(store.messageMap[parent.id]!.removed_at).not.toBeNull();
    expect(bodies(store, "c-general")).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 10}`));
    await store.loadOlderMessages("c-general");
    expect(bodies(store, "c-general").filter((body) => body.startsWith("m"))).toEqual(
      Array.from({ length: 60 }, (_, i) => `m${i}`)
    );
  });

  it("offers a retry when the first message can't be read though its replies can", async () => {
    const { store, server } = await setup((s) => {
      const old = s.post("c-general", ADA, "old parent");
      s.post("c-general", ADA, "reply", old.id);
      for (let i = 0; i < 60; i++) s.post("c-general", ADA, `m${i}`);
    });
    await store.openChannel("c-general");
    const parent = server.messages[0]!;
    server.holds.set("getMessage", Promise.reject(new ChatServiceError(0, undefined)));
    await store.openThread("c-general", parent.id);
    expect(replies(store, parent.id)).toEqual(["reply"]);
    expect(store.messageMap[parent.id]).toBeUndefined();
    expect(store.getThreadState(parent.id)!.error).toBe(true);
    await store.openThread("c-general", parent.id);
    expect(store.messageMap[parent.id]?.body_stripped).toBe("old parent");
  });

  it("shows a new reply live and updates the parent's summary, without counting it unread", async () => {
    const { store, server, socket, parent } = await withThread(1);
    await store.openThread("c-general", parent.id);
    store.setDocumentVisible(false);
    const reply = server.post("c-general", ADA, "live", parent.id);
    socket.emit(server.createdEvent(reply));
    await settle();
    expect(replies(store, parent.id)).toEqual(["r0", "live"]);
    expect(store.messageMap[parent.id]!.reply_count).toBe(2);
    expect(store.messageMap[parent.id]!.last_reply_at).toBe(reply.created_at);
    expect(store.channelMap["c-general"]!.unread_count).toBe(0);
    expect(bodies(store, "c-general")).toEqual(["parent"]);
  });

  it("only re-reads the parent for a reply in a thread that isn't open", async () => {
    const { store, server, socket, parent } = await withThread(0);
    server.calls = [];
    const reply = server.post("c-general", ADA, "elsewhere", parent.id);
    socket.emit(server.createdEvent(reply));
    await settle();
    expect(server.calls).toEqual([`getMessage ${parent.id}`]);
    expect(store.messageMap[reply.id]).toBeUndefined();
    expect(store.getChannelMessages("c-general")[0]!.reply_count).toBe(1);
  });

  it("shows an edit to a reply, and drops a removed one from the thread and the count", async () => {
    const { store, server, socket, parent } = await withThread(2);
    await store.openThread("c-general", parent.id);
    const [first, second] = server.messages.slice(1);
    first!.body_stripped = "r0 (edited)";
    first!.updated_at = "2026-01-02T00:00:00Z";
    socket.emit(server.changedEvent("message.updated", first!));
    socket.emit(server.changedEvent("message.removed", server.remove(second!.id)));
    await settle();
    expect(replies(store, parent.id)).toEqual(["r0 (edited)"]);
    expect(store.messageMap[parent.id]!.reply_count).toBe(1);
    expect(store.messageMap[parent.id]!.last_reply_at).toBe(first!.created_at);
  });

  it("keeps the thread of a removed first message open, showing it removed", async () => {
    const { store, server, socket, parent } = await withThread(1);
    await store.openThread("c-general", parent.id);
    socket.emit(server.changedEvent("message.removed", server.remove(parent.id)));
    await settle();
    expect(store.messageMap[parent.id]!.removed_at).not.toBeNull();
    expect(store.messageMap[parent.id]!.reply_count).toBe(1);
    expect(store.activeThread?.parentId).toBe(parent.id);
    expect(replies(store, parent.id)).toEqual(["r0"]);
  });

  it("puts the latest summary last when two replies' re-reads answer out of order", async () => {
    const { store, server, socket, parent } = await withThread(0);
    const slow = holdOpen();
    server.holds.set("getMessage", slow.opened);
    socket.emit(server.createdEvent(server.post("c-general", ADA, "one", parent.id)));
    await tick();
    // The first re-read is held, answering with one reply; the second event arrives meanwhile.
    socket.emit(server.createdEvent(server.post("c-general", ADA, "two", parent.id)));
    slow.open();
    await settle();
    expect(store.getChannelMessages("c-general")[0]!.reply_count).toBe(2);
  });

  describe("replying", () => {
    it("shows a reply as pending, then as sent, and updates the parent", async () => {
      const { store, server, parent } = await withThread(1);
      await store.openThread("c-general", parent.id);
      const sent = holdOpen();
      server.holds.set("sendMessage", sent.opened);
      server.calls = [];
      const sending = store.sendReply("c-general", parent.id, { body_html: "<p>mine</p>" });
      expect(store.getPendingReplies(parent.id).map((p) => p.status)).toEqual(["sending"]);
      expect(store.getPendingMessages("c-general")).toEqual([]);
      sent.open();
      await sending;
      expect(store.getPendingReplies(parent.id)).toEqual([]);
      expect(replies(store, parent.id)).toEqual(["r0", "<p>mine</p>"]);
      expect(store.messageMap[parent.id]!.reply_count).toBe(2);
      expect(server.messages.at(-1)!.parent).toBe(parent.id);
      // A reply doesn't move the channel's read cursor or its activity.
      expect(server.calls.some((c) => c.startsWith("markRead"))).toBe(false);
    });

    it("ignores the event for its own reply", async () => {
      const { store, server, socket, parent } = await withThread(0);
      await store.openThread("c-general", parent.id);
      await store.sendReply("c-general", parent.id, { body_html: "<p>mine</p>" });
      socket.emit(server.createdEvent(server.messages.at(-1)!));
      await settle();
      expect(replies(store, parent.id)).toEqual(["<p>mine</p>"]);
    });

    it("keeps a failed reply to retry, once, or to discard with its files", async () => {
      const { store, server, parent } = await withThread(0);
      await store.openThread("c-general", parent.id);
      server.failSends = true;
      const attachment = { id: "asset-a", name: "a.png", type: "image/png", size: 1 };
      await expect(
        store.sendReply("c-general", parent.id, { body_html: "<p>a</p>", attachments: [attachment] })
      ).rejects.toThrow();
      await expect(store.sendReply("c-general", parent.id, { body_html: "<p>b</p>" })).rejects.toThrow();
      const [a, b] = store.getPendingReplies(parent.id);
      expect([a!.status, b!.status]).toEqual(["failed", "failed"]);

      server.failSends = false;
      await store.retryMessage("c-general", a!.localId);
      expect(store.getPendingReplies(parent.id).map((p) => p.localId)).toEqual([b!.localId]);
      expect(replies(store, parent.id)).toEqual(["<p>a</p>"]);
      expect(server.sentAttachmentIds.at(-1)).toEqual(["asset-a"]);
      // Retrying what already went sends nothing.
      await store.retryMessage("c-general", a!.localId);
      expect(server.messages.filter((m) => m.parent === parent.id)).toHaveLength(1);

      store.discardMessage("c-general", b!.localId);
      expect(store.getPendingReplies(parent.id)).toEqual([]);
    });

    it("keeps a failed reply across closing and reopening the thread", async () => {
      const { store, server, parent } = await withThread(0);
      await store.openThread("c-general", parent.id);
      server.failSends = true;
      await expect(store.sendReply("c-general", parent.id, { body_html: "<p>a</p>" })).rejects.toThrow();
      store.closeThread();
      await store.openThread("c-general", parent.id);
      expect(store.getPendingReplies(parent.id).map((p) => p.status)).toEqual(["failed"]);
    });
  });

  describe("after a reconnect", () => {
    it("pages after the newest reply it had, without dropping or repeating any", async () => {
      const { store, server, socket, parent } = await withThread(3);
      await store.openThread("c-general", parent.id);
      socket.handlers.onStatusChange?.("reconnecting", null);
      for (let i = 0; i < 120; i++) server.post("c-general", ADA, `missed ${i}`, parent.id);
      // Sent while disconnected: it lands at the end, and mustn't make the catch-up skip what came before it.
      await store.sendReply("c-general", parent.id, { body_html: "<p>mine</p>" });
      server.calls = [];
      socket.ready(true);
      await settle();

      const shown = store.getThreadReplies(parent.id);
      expect(shown.map((m) => m.body_stripped)).toEqual([
        ...Array.from({ length: 3 }, (_, i) => `r${i}`),
        ...Array.from({ length: 120 }, (_, i) => `missed ${i}`),
        "<p>mine</p>",
      ]);
      expect(new Set(shown.map((m) => m.id)).size).toBe(shown.length);
      expect(server.calls.filter((c) => c.startsWith(`listReplies ${parent.id} {"after"`))).toHaveLength(3);
      expect(store.messageMap[parent.id]!.reply_count).toBe(124);
      expect(bodies(store, "c-general")).toEqual(["parent"]);
    });

    it("re-reads the newest replies for edits and removals it missed", async () => {
      const { store, server, socket, parent } = await withThread(2);
      await store.openThread("c-general", parent.id);
      const [first, second] = server.messages.slice(1);
      first!.body_stripped = "r0 (edited)";
      server.remove(second!.id);
      socket.ready(true);
      await settle();
      expect(replies(store, parent.id)).toEqual(["r0 (edited)"]);
      expect(store.messageMap[parent.id]!.reply_count).toBe(1);
    });

    it("reloads a thread that had no replies when events stopped", async () => {
      const { store, server, socket, parent } = await withThread(0);
      await store.openThread("c-general", parent.id);
      server.post("c-general", ADA, "missed", parent.id);
      socket.handlers.onResync?.("events_missed");
      await settle();
      expect(replies(store, parent.id)).toEqual(["missed"]);
      expect(store.messageMap[parent.id]!.reply_count).toBe(1);
    });

    it("leaves a closed thread alone", async () => {
      const { store, server, socket, parent } = await withThread(1);
      await store.openThread("c-general", parent.id);
      store.closeThread();
      server.calls = [];
      socket.ready(true);
      await settle();
      expect(server.calls.some((c) => c.startsWith("listReplies"))).toBe(false);
      expect(store.getThreadState(parent.id)).toBeUndefined();
    });
  });

  it("closes the thread with its channel, and forgets its replies", async () => {
    const { store, parent } = await withThread(2);
    await store.openThread("c-general", parent.id);
    const replyIds = store.getThreadState(parent.id)!.ids;
    store.closeChannel();
    expect(store.activeThread).toBeNull();
    expect(store.getThreadState(parent.id)).toBeUndefined();
    expect(replyIds.some((id) => store.messageMap[id])).toBe(false);
  });

  it("drops a page that lands after the thread closed", async () => {
    const { store, server, parent } = await withThread(1);
    const load = holdOpen();
    server.holds.set("listReplies", load.opened);
    void store.openThread("c-general", parent.id);
    await tick();
    store.closeThread();
    load.open();
    await settle();
    expect(store.getThreadState(parent.id)).toBeUndefined();
  });

  it("says when the thread can't be read, and loads it on a retry", async () => {
    const { store, server } = await setup();
    await store.openChannel("c-general");
    // Not there yet: the fake server names its first message m0001.
    await store.openThread("c-general", "m0001");
    expect(store.getThreadState("m0001")!.error).toBe(true);
    expect(store.messageMap.m0001).toBeUndefined();
    server.post("c-general", ADA, "found");
    await store.openThread("c-general", "m0001");
    expect(store.getThreadState("m0001")!.loaded).toBe(true);
    expect(store.messageMap.m0001?.body_stripped).toBe("found");
  });

  describe("revealReply", () => {
    it("loads back through the thread until the reply is there", async () => {
      const { store, server, parent } = await withThread(120);
      await store.openThread("c-general", parent.id);
      const oldest = server.messages[1]!;
      expect(await store.revealReply(parent.id, oldest.id)).toBe(true);
      expect(store.getThreadReplies(parent.id)).toHaveLength(120);
    });

    it("can't reveal a removed reply", async () => {
      const { store, server, parent } = await withThread(2);
      server.remove(server.messages[1]!.id);
      await store.openThread("c-general", parent.id);
      expect(await store.revealReply(parent.id, server.messages[1]!.id)).toBe(false);
    });
  });
});

const found = (store: ChatStore) => store.search?.results.map((result) => result.message.body_stripped);

describe("ChatStore search", () => {
  it("finds matches newest first, and pages back from the last one", async () => {
    const { store, server } = await setup((s) => {
      for (let i = 0; i < 25; i++) s.post(i % 2 ? "c-general" : "c-random", ADA, `deploy ${i}`);
    });
    await store.searchMessages("  deploy ");
    expect(store.search).toMatchObject({ query: "deploy", loading: false, hasMore: true, error: false });
    expect(found(store)).toHaveLength(20);
    expect(found(store)?.[0]).toBe("deploy 24");
    expect(server.calls).toEqual([`searchMessages ${JSON.stringify({ q: "deploy", limit: 20 })}`]);

    await store.loadMoreSearchResults();
    expect(found(store)).toEqual(Array.from({ length: 25 }, (_, i) => `deploy ${24 - i}`));
    expect(store.search?.hasMore).toBe(false);
    expect(server.calls[1]).toContain(`"before":"${server.messages[5]!.id}"`);
  });

  it("sends the filters it was given", async () => {
    const { store, server } = await setup();
    await store.searchMessages("deploy", { channelId: "c-general", senderId: ADA, excludeAutomatic: true });
    expect(server.calls).toEqual([
      `searchMessages ${JSON.stringify({ q: "deploy", limit: 20, channel: "c-general", sender: ADA, automatic: false })}`,
    ]);
    expect(store.search?.filters).toEqual({ channelId: "c-general", senderId: ADA, excludeAutomatic: true });
  });

  it("doesn't send a search shorter than two characters, and ends the one showing", async () => {
    const { store, server } = await setup((s) => s.post("c-general", ADA, "deploy"));
    await store.searchMessages("deploy");
    await store.searchMessages(" d ");
    expect(store.search).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  it("shows loading, then an error, then results on a retry", async () => {
    const { store, server } = await setup((s) => s.post("c-general", ADA, "deploy"));
    let fail!: (error: unknown) => void;
    server.holds.set("searchMessages", new Promise<void>((_, reject) => (fail = reject)));
    const searching = store.searchMessages("deploy");
    expect(store.search).toMatchObject({ loading: true, results: [] });
    fail(new ChatServiceError(0, undefined));
    await searching;
    expect(store.search).toMatchObject({ loading: false, error: true });
    await store.searchMessages("deploy");
    expect(store.search).toMatchObject({ error: false });
    expect(found(store)).toEqual(["deploy"]);
  });

  it("says when a search was refused for going too fast, until one goes through", async () => {
    const { store, server } = await setup((s) => s.post("c-general", ADA, "deploy"));
    server.holds.set("searchMessages", Promise.reject(new ChatServiceError(429, {}, 30)));
    await store.searchMessages("deploy");
    expect(store.search).toMatchObject({ query: "deploy", error: true, rateLimited: true });
    await store.searchMessages("deploy");
    expect(store.search).toMatchObject({ error: false, rateLimited: false });
    server.holds.set("searchMessages", Promise.reject(new ChatServiceError(500, undefined)));
    await store.searchMessages("deploy");
    expect(store.search).toMatchObject({ error: true, rateLimited: false });
  });

  it("drops the answer to an older search that lands after a newer one", async () => {
    const { store, server } = await setup((s) => {
      s.post("c-general", ADA, "alpha");
      s.post("c-general", ADA, "beta");
    });
    let releaseOld!: () => void;
    server.holds.set("searchMessages", new Promise<void>((resolve) => (releaseOld = resolve)));
    const older = store.searchMessages("alpha");
    await store.searchMessages("beta");
    releaseOld();
    await older;
    expect(store.search?.query).toBe("beta");
    expect(found(store)).toEqual(["beta"]);
  });

  it("drops a further page that lands after the search changed or ended", async () => {
    const { store, server } = await setup((s) => {
      for (let i = 0; i < 25; i++) s.post("c-general", ADA, `deploy ${i}`);
    });
    await store.searchMessages("deploy");
    let release!: () => void;
    server.holds.set("searchMessages", new Promise<void>((resolve) => (release = resolve)));
    const more = store.loadMoreSearchResults();
    expect(store.search?.loadingMore).toBe(true);
    store.clearSearch();
    release();
    await more;
    expect(store.search).toBeNull();
  });

  it("offers a retry when a further page fails, and shows each result once", async () => {
    const { store, server } = await setup((s) => {
      for (let i = 0; i < 25; i++) s.post("c-general", ADA, `deploy ${i}`);
    });
    await store.searchMessages("deploy");
    server.holds.set("searchMessages", Promise.reject(new ChatServiceError(500, undefined)));
    await store.loadMoreSearchResults();
    expect(store.search).toMatchObject({ loadingMore: false, moreFailed: true, hasMore: true });
    await store.loadMoreSearchResults();
    const ids = store.search!.results.map((result) => result.message.id);
    expect(new Set(ids).size).toBe(25);
    expect(store.search?.moreFailed).toBe(false);
  });

  it("shows a result once when it moved to the next page", async () => {
    const { store, server } = await setup((s) => {
      for (let i = 0; i < 25; i++) s.post("c-general", ADA, `deploy ${i}`);
    });
    await store.searchMessages("deploy");
    const search = server.search.bind(server);
    // An edit made the oldest result on the first page newer, as far as paging is concerned.
    server.search = (query) => {
      const page = search(query);
      return { ...page, results: [store.search!.results[19]!, ...page.results] };
    };
    await store.loadMoreSearchResults();
    const ids = store.search!.results.map((result) => result.message.id);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });

  it("forgets the search when the store stops", async () => {
    const { store } = await setup((s) => s.post("c-general", ADA, "deploy"));
    await store.searchMessages("deploy");
    store.stop();
    expect(store.search).toBeNull();
  });
});

describe("ChatStore channel members and agents", () => {
  const agentEvent = (type: "member.added" | "member.removed", channelId: string, agentId: string): TChatEvent => ({
    type,
    workspace_id: WORKSPACE_ID,
    channel_id: channelId,
    agent_id: agentId,
    actor_id: ADA,
    at: "t",
  });

  it("loads a channel's people and agents only when asked", async () => {
    const { store, server } = await setup((s) => s.agents.set("c-general", [channelAgent("c-general", "bot")]));
    expect(server.calls).toEqual([]);
    await Promise.all([store.fetchChannelMembers("c-general"), store.fetchChannelAgents("c-general")]);
    expect(store.channelMembers["c-general"]!.map((m) => m.user)).toEqual([ME]);
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);
  });

  it("re-reads only the agents on an agent's member event, and only while they're shown", async () => {
    const { store, server, socket } = await setup();
    await Promise.all([store.fetchChannelMembers("c-general"), store.fetchChannelAgents("c-general")]);
    server.calls = [];

    server.agents.set("c-general", [channelAgent("c-general", "bot")]);
    socket.emit(agentEvent("member.added", "c-general", "bot"));
    await settle();
    // Not the channel, whose member count is people only, and not its people.
    expect(server.calls).toEqual(["listAgents c-general"]);
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);

    store.forgetChannelMembers("c-general");
    server.calls = [];
    socket.emit(agentEvent("member.removed", "c-general", "bot"));
    await settle();
    expect(server.calls).toEqual([]);
    expect(store.channelAgents["c-general"]).toBeUndefined();
  });

  it("drops agents that load after the list was closed, and so stops re-reading them", async () => {
    const { store, server, socket } = await setup((s) => s.agents.set("c-general", [channelAgent("c-general", "bot")]));
    const slow = holdOpen();
    server.holds.set("listAgents", slow.opened);
    const loading = store.fetchChannelAgents("c-general");
    store.forgetChannelMembers("c-general");
    slow.open();
    await loading;
    expect(store.channelAgents["c-general"]).toBeUndefined();

    server.calls = [];
    socket.emit(agentEvent("member.removed", "c-general", "bot"));
    await settle();
    expect(server.calls).toEqual([]);

    // Shown again: loads as usual.
    await store.fetchChannelAgents("c-general");
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);
  });

  it("treats a member event naming nobody as an agent's, from a gateway that drops agent_id", async () => {
    const { store, server, socket } = await setup();
    await store.fetchChannelAgents("c-general");
    server.calls = [];
    socket.emit({ type: "member.removed", workspace_id: WORKSPACE_ID, channel_id: "c-general", at: "t" });
    await settle();
    expect(server.calls).toEqual(["listAgents c-general"]);
  });

  it("re-reads the people shown, and the channel, on a person's member event", async () => {
    const { store, server, socket } = await setup();
    await store.fetchChannelMembers("c-general");
    server.calls = [];
    server.channels.get("c-general")!.members.add(ADA);
    socket.emit({ type: "member.added", workspace_id: WORKSPACE_ID, channel_id: "c-general", user_id: ADA, at: "t" });
    await settle();
    expect(sortBy(server.calls)).toEqual(["getChannel c-general", "listMembers c-general"]);
    expect(store.channelMembers["c-general"]!.map((m) => m.user)).toEqual([ME, ADA]);
    expect(store.channelMap["c-general"]!.member_count).toBe(2);
  });

  it("adds people to the list shown, and removes one", async () => {
    const { store, server } = await setup();
    await store.fetchChannelMembers("c-general");
    await store.addChannelMembers("c-general", [ADA, ME]);
    expect(server.calls).toContain(`addMembers c-general ${ADA},${ME}`);
    expect(store.channelMembers["c-general"]!.map((m) => m.user)).toEqual([ME, ADA]);

    await store.removeChannelMember("c-general", ADA);
    expect(server.calls).toContain(`removeMember c-general ${ADA}`);
    expect(store.channelMembers["c-general"]!.map((m) => m.user)).toEqual([ME]);

    // Nothing shows the list: the change is made, and no list is held for it.
    store.forgetChannelMembers("c-general");
    await store.addChannelMembers("c-general", [ADA]);
    expect(store.channelMembers["c-general"]).toBeUndefined();
  });

  it("adds an agent once, and removes it", async () => {
    const { store, server } = await setup();
    await store.fetchChannelAgents("c-general");
    await store.addChannelAgent("c-general", { agent_id: "bot", permission_level: "ask_all" });
    await store.addChannelAgent("c-general", { agent_id: "bot" });
    expect(store.channelAgents["c-general"]!.map((a) => [a.agent, a.permission_level])).toEqual([["bot", "ask_all"]]);
    expect(server.calls).toContain("addAgent c-general bot ask_all");

    await store.removeChannelAgent("c-general", "bot");
    expect(store.channelAgents["c-general"]).toEqual([]);
  });

  it("drops an agent someone else removed first, and re-reads the rest", async () => {
    const { store, server } = await setup((s) =>
      s.agents.set("c-general", [channelAgent("c-general", "bot"), channelAgent("c-general", "helper")])
    );
    await store.fetchChannelAgents("c-general");
    server.agents.set("c-general", [channelAgent("c-general", "helper")]);
    await store.removeChannelAgent("c-general", "bot");
    await settle();
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["helper"]);
    expect(server.calls).toContain("listAgents c-general");
  });

  it("passes on a refusal to remove", async () => {
    const { store, server } = await setup((s) => s.agents.set("c-general", [channelAgent("c-general", "bot")]));
    await store.fetchChannelAgents("c-general");
    const refusal = new ChatServiceError(403, { error: "Only a channel admin or a workspace admin can do this." });
    server.removeAgentFailure = refusal;
    await expect(store.removeChannelAgent("c-general", "bot")).rejects.toBe(refusal);
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);
  });

  it("re-reads the lists shown after a resync, when events may have been missed", async () => {
    const { store, server, socket } = await setup();
    await Promise.all([store.fetchChannelMembers("c-general"), store.fetchChannelAgents("c-general")]);
    server.agents.set("c-general", [channelAgent("c-general", "bot")]);
    server.calls = [];
    socket.handlers.onResync?.("events_missed");
    await settle();
    expect(server.calls).toContain("listAgents c-general");
    expect(server.calls).toContain("listMembers c-general");
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);
  });

  it("lists the registry's agents, and forgets everything on stop", async () => {
    const { store, server } = await setup((s) => {
      s.registry = [
        {
          id: "bot",
          name: "Bot",
          slug: "bot",
          description: "",
          adapter: "claude",
          default_permission_level: "ask_all",
          max_permission_level: "ask_writes",
          credential_source: "instance",
        },
      ];
    });
    await store.fetchAvailableAgents();
    await store.fetchChannelAgents("c-general");
    expect(store.availableAgents!.map((a) => a.id)).toEqual(["bot"]);
    expect(server.calls).toContain("listAvailableAgents");
    store.stop();
    expect(store.availableAgents).toBeNull();
    expect(store.channelAgents).toEqual({});
    expect(store.channelMembers).toEqual({});
  });
});

describe("ChatStore agents answering mentions", () => {
  const agentEvent = (
    type: "agent.responding" | "agent.responded",
    agentId: string,
    messageId: string,
    threadId = messageId
  ): TChatEvent => ({
    type,
    workspace_id: WORKSPACE_ID,
    channel_id: "c-general",
    message_id: messageId,
    parent_id: threadId,
    agent_id: agentId,
    at: "t",
  });

  it("keeps a channel's agents while they are watched, whatever the members dialog does", async () => {
    const { store, server } = await setup((s) => s.agents.set("c-general", [channelAgent("c-general", "bot")]));
    const release = store.watchChannelAgents("c-general");
    await settle();
    expect(server.calls).toEqual(["listAgents c-general"]);
    // The members dialog opens and closes meanwhile.
    await store.fetchChannelAgents("c-general");
    store.forgetChannelMembers("c-general");
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);
    const second = store.watchChannelAgents("c-general");
    release();
    release();
    expect(store.channelAgents["c-general"]).toBeDefined();
    second();
    expect(store.channelAgents["c-general"]).toBeUndefined();
  });

  it("keeps re-reading watched agents after the members dialog closes", async () => {
    const { store, server, socket } = await setup();
    store.watchChannelAgents("c-general");
    await store.fetchChannelAgents("c-general");
    store.forgetChannelMembers("c-general");
    server.calls = [];
    server.agents.set("c-general", [channelAgent("c-general", "bot")]);
    socket.emit({
      type: "member.added",
      workspace_id: WORKSPACE_ID,
      channel_id: "c-general",
      agent_id: "bot",
      at: "t",
    });
    await settle();
    expect(server.calls).toEqual(["listAgents c-general"]);
    expect(store.channelAgents["c-general"]!.map((a) => a.agent)).toEqual(["bot"]);
  });

  it("offers the channel's available agents to mention, to a member who may run agents", async () => {
    const { store } = await setup((s) => {
      s.agents.set("c-general", [
        channelAgent("c-general", "bot"),
        { ...channelAgent("c-general", "off"), is_available: false },
      ]);
      s.agents.set("c-open", [channelAgent("c-open", "bot")]);
    });
    store.watchChannelAgents("c-general");
    store.watchChannelAgents("c-open");
    await settle();
    expect(store.getMentionableAgents("c-general").map((a) => a.agent)).toEqual(["bot"]);
    // Not in a channel the user hasn't joined, even though it has agents.
    expect(store.getMentionableAgents("c-open")).toEqual([]);
    expect(store.getAgentName("off")).toBe("Agent off");
    expect(store.getAgentName("nobody")).toBeUndefined();
  });

  it("offers no agents to someone who may not run them", async () => {
    const { store } = await setup((s) => {
      s.canMentionAgents = false;
      s.agents.set("c-general", [channelAgent("c-general", "bot")]);
    });
    store.watchChannelAgents("c-general");
    await settle();
    expect(store.getMentionableAgents("c-general")).toEqual([]);
    // Their mentions are still named.
    expect(store.getAgentName("bot")).toBe("Agent bot");
  });

  it("offers no agents in an archived channel", async () => {
    const { store, server, socket } = await setup((s) => s.agents.set("c-general", [channelAgent("c-general", "bot")]));
    store.watchChannelAgents("c-general");
    await settle();
    server.channels.get("c-general")!.archived = true;
    socket.emit({ type: "channel.archived", workspace_id: WORKSPACE_ID, channel_id: "c-general", at: "t" });
    await settle();
    expect(store.getMentionableAgents("c-general")).toEqual([]);
  });

  it("shows an agent as responding in the thread until it has responded", async () => {
    const { store, socket } = await setup();
    socket.emit(agentEvent("agent.responding", "bot", "m1"));
    socket.emit(agentEvent("agent.responding", "bot", "m1"));
    socket.emit(agentEvent("agent.responding", "helper", "m2", "m1"));
    expect(store.getRespondingAgents("m1")).toEqual([
      { channelId: "c-general", agentId: "bot", messageId: "m1" },
      { channelId: "c-general", agentId: "helper", messageId: "m2" },
    ]);
    socket.emit(agentEvent("agent.responded", "bot", "m1"));
    expect(store.getRespondingAgents("m1").map((a) => a.agentId)).toEqual(["helper"]);
    socket.emit(agentEvent("agent.responded", "helper", "m2", "m1"));
    expect(store.getRespondingAgents("m1")).toEqual([]);
    expect(store.respondingAgents).toEqual({});
  });

  it("stops showing an agent as responding once its time is up, if no event says so", async () => {
    const { store, socket } = await setup();
    vi.useFakeTimers();
    try {
      socket.emit(agentEvent("agent.responding", "bot", "m1"));
      vi.advanceTimersByTime(300_000);
      expect(store.getRespondingAgents("m1")).toHaveLength(1);
      vi.advanceTimersByTime(60_001);
      expect(store.getRespondingAgents("m1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an agent event without the IDs it needs, and forgets them all on stop", async () => {
    const { store, socket } = await setup();
    socket.emit({ ...agentEvent("agent.responding", "bot", "m1"), parent_id: undefined });
    expect(store.respondingAgents).toEqual({});
    socket.emit(agentEvent("agent.responding", "bot", "m1"));
    store.stop();
    expect(store.respondingAgents).toEqual({});
  });
});

const permissionPrompt = (id: string): TChatAgentPermissionRequest => ({
  id,
  title: "Edit work item WEB-1",
  options: [
    { option_id: "allow", name: "Allow", kind: "allow_once" },
    { option_id: "reject", name: "Reject", kind: "reject_once" },
  ],
  message_id: null,
  expires_at: "2026-01-05T00:05:00Z",
});

describe("ChatStore agent DMs", () => {
  const AGENT = "agent-maia";
  const registry = (s: FakeChatServer) => {
    s.registry = [
      {
        id: AGENT,
        name: "Maia",
        slug: "maia",
        description: "",
        adapter: "claude",
        default_permission_level: "ask_writes",
        max_permission_level: "yolo",
        credential_source: "instance",
      },
    ];
  };
  const event = (type: TChatEvent["type"], extra: Partial<TChatEvent> = {}): TChatEvent => ({
    type,
    workspace_id: WORKSPACE_ID,
    channel_id: "adm-1",
    at: "2026-01-05T00:00:00Z",
    ...extra,
  });

  it("lists agent DMs in their own list, newest activity first, apart from DMs", async () => {
    const { store } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
      s.addAgentDm("adm-2", AGENT);
      s.post("adm-1", ME, "older");
      s.post("adm-2", ME, "newer");
      s.addChannel("dm-1", { kind: "dm", members: [ME, ADA] });
    });
    expect(store.agentDms.map((c) => c.id)).toEqual(["adm-2", "adm-1"]);
    expect(store.directMessages.map((c) => c.id)).toEqual(["dm-1"]);
    expect(store.channelMap["adm-1"]!.agent_dm!.agent!.name).toBe("Maia");
    expect(store.me?.can_open_agent_dms).toBe(true);
  });

  it("opens the agent's DM, the same one again the second time", async () => {
    const { store, server } = await setup(registry);
    const first = await store.openAgentDm(AGENT);
    const second = await store.openAgentDm(AGENT);
    expect(first.id).toBe("adm-agent-maia");
    expect(second.id).toBe(first.id);
    expect(store.agentDms.map((c) => c.id)).toEqual([first.id]);
    expect(server.calls).toEqual([`openAgentDm ${AGENT}`, `openAgentDm ${AGENT}`]);
  });

  it("offers no agents to mention in an agent DM", async () => {
    const { store } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
    });
    expect(store.getMentionableAgents("adm-1")).toEqual([]);
  });

  it("doesn't count an agent's draft as unread, and takes the API's count once it has responded", async () => {
    const { store, server, socket } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
    });
    const draft = server.post("adm-1", ME, "partial");
    draft.sender = null;
    draft.sender_agent = "maia";
    draft.agent_streaming = true;
    socket.emit({ ...server.createdEvent(draft), actor_id: undefined });
    await settle();
    expect(store.channelMap["adm-1"]!.unread_count).toBe(0);

    server.agentDms.get("adm-1")!.responding = true;
    socket.emit(event("agent.responding", { message_id: "m-ask", agent_id: AGENT }));
    await settle();
    expect(server.calls).toContain("getChannel adm-1");
    expect(store.channelMap["adm-1"]!.agent_dm!.responding).toBe(true);

    draft.agent_streaming = false;
    server.agentDms.get("adm-1")!.responding = false;
    server.calls = [];
    socket.emit(event("agent.responded", { message_id: "m-ask", agent_id: AGENT }));
    await settle();
    expect(server.calls).toContain("getChannel adm-1");
    expect(store.channelMap["adm-1"]!.agent_dm!.responding).toBe(false);
    // The fake's unread counts any top-level message not the user's; the API leaves drafts out until they finish.
    expect(store.channelMap["adm-1"]!.unread_count).toBe(1);
    // Nothing is shown as responding in a thread: the DM's own state says it.
    expect(store.respondingAgents).toEqual({});
  });

  it("re-reads an agent DM when its agent is disabled, so it shows read-only", async () => {
    const { store, server, socket } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
    });
    server.agentDms.get("adm-1")!.read_only_reason = "agent_unavailable";
    socket.emit(event("member.removed", { agent_id: AGENT }));
    await settle();
    expect(store.channelMap["adm-1"]!.agent_dm!.read_only_reason).toBe("agent_unavailable");
  });

  it("holds the pending permission prompts while the DM is open, re-read on their events", async () => {
    const { store, server, socket } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
    });
    await store.openChannel("adm-1");
    expect(server.calls).toContain("listAgentPermissions adm-1");
    expect(store.getAgentPermissions("adm-1")).toEqual([]);

    server.permissions.set("adm-1", [permissionPrompt("p1")]);
    socket.emit(event("agent.permission_requested", { user_id: ME, agent_id: AGENT }));
    await settle();
    expect(store.getAgentPermissions("adm-1").map((p) => p.id)).toEqual(["p1"]);

    server.permissions.set("adm-1", []);
    socket.emit(event("agent.permission_resolved", { user_id: ME, agent_id: AGENT }));
    await settle();
    expect(store.getAgentPermissions("adm-1")).toEqual([]);

    store.closeChannel();
    server.calls = [];
    socket.emit(event("agent.permission_requested", { user_id: ME, agent_id: AGENT }));
    await settle();
    expect(server.calls).toEqual([]);
    expect(store.agentPermissions).toEqual({});
  });

  it("answers a permission prompt, and re-reads the list when it was no longer pending", async () => {
    const { store, server } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
      s.permissions.set("adm-1", [permissionPrompt("p1"), permissionPrompt("p2")]);
    });
    await store.openChannel("adm-1");
    await store.answerAgentPermission("adm-1", "p1", "allow");
    expect(server.calls).toContain("answerAgentPermission adm-1 p1 allow");
    expect(store.getAgentPermissions("adm-1").map((p) => p.id)).toEqual(["p2"]);

    server.answerFailure = new ChatServiceError(409, { error: "No longer pending." });
    server.calls = [];
    await expect(store.answerAgentPermission("adm-1", "p2", "reject")).rejects.toMatchObject({ status: 409 });
    await settle();
    expect(server.calls).toContain("listAgentPermissions adm-1");
    expect(store.getAgentPermissions("adm-1")).toEqual([]);
  });

  it("stops the running turn, and takes 'nothing running' as stopped", async () => {
    const { store, server } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT, { responding: true });
    });
    expect(store.channelMap["adm-1"]!.agent_dm!.responding).toBe(true);
    await store.stopAgentTurn("adm-1");
    expect(server.calls).toEqual(["stopAgentTurn adm-1", "getChannel adm-1"]);
    expect(store.channelMap["adm-1"]!.agent_dm!.responding).toBe(false);

    server.stopFailure = new ChatServiceError(409, {});
    await expect(store.stopAgentTurn("adm-1")).resolves.toBeUndefined();
    server.stopFailure = new ChatServiceError(503, {});
    await expect(store.stopAgentTurn("adm-1")).rejects.toMatchObject({ status: 503 });
  });

  it("changes the level the agent works at in the DM", async () => {
    const { store, server } = await setup((s) => {
      registry(s);
      s.addAgentDm("adm-1", AGENT);
    });
    await store.setAgentDmLevel("adm-1", "yolo");
    expect(server.calls).toEqual(["setAgentDmLevel adm-1 yolo"]);
    expect(store.channelMap["adm-1"]!.agent_dm!.permission_level).toBe("yolo");
  });
});
