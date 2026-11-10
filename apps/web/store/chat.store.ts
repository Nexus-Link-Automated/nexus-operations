/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { orderBy, sortBy } from "lodash-es";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
// plane imports
import { ChatService, ChatServiceError, ChatSocket } from "@plane/services";
import type { TChatSocketClosedReason, TChatSocketHandlers, TChatSocketStatus } from "@plane/services";
import type {
  TChatChannel,
  TChatChannelCreate,
  TChatChannelUpdate,
  TChatEvent,
  TChatMe,
  TChatMessage,
  TChatMessageEdit,
  TChatMessagePage,
  TChatMessageWrite,
  TChatSearchResult,
  TChatUploadedAttachment,
} from "@plane/types";

/** The REST calls the store makes. `ChatService` in the app; a fake in tests. */
export type TChatStoreService = Pick<
  ChatService,
  | "me"
  | "listChannels"
  | "getChannel"
  | "createChannel"
  | "updateChannel"
  | "openDm"
  | "joinChannel"
  | "leaveChannel"
  | "markRead"
  | "listMessages"
  | "listReplies"
  | "searchMessages"
  | "getMessage"
  | "sendMessage"
  | "linkWorkItem"
  | "editMessage"
  | "removeMessage"
  | "uploadAttachment"
  | "deleteAttachment"
>;

/** The socket calls the store makes. `ChatSocket` in the app; a fake in tests. */
export type TChatStoreSocket = Pick<
  ChatSocket,
  "connect" | "close" | "subscribe" | "unsubscribe" | "reconnectNow" | "noteActivity"
>;

export type TChatSocketFactory = (workspaceSlug: string, handlers: TChatSocketHandlers) => TChatStoreSocket;

/** Top-level messages of one channel that the store holds: always a contiguous run that ends at the newest. */
export type TChatChannelMessages = {
  /** Oldest to newest. */
  ids: string[];
  hasMoreOlder: boolean;
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  /** The last try at an older page failed; the list offers a retry. */
  olderFailed: boolean;
  error: boolean;
};

/**
 * One thread's replies that the store holds, like `TChatChannelMessages`. Only the open thread is held: closing it
 * drops this, so nothing has to keep a thread nobody is looking at up to date.
 */
export type TChatThreadMessages = TChatChannelMessages & { channelId: string };

/** The thread open beside the conversation. `parentId` is its first message, the one the channel shows. */
export type TChatActiveThread = { channelId: string; parentId: string };

/** A message on its way to the API. Shown at the bottom of the channel, or of its thread, until the API has it. */
export type TChatPendingMessage = {
  localId: string;
  channelId: string;
  /** A thread reply's first message; null for a message in the channel. */
  parentId: string | null;
  body_html: string;
  body_json: Record<string, unknown>;
  /** Already in storage: a retry sends these again by ID and never re-uploads them. */
  attachments: TChatUploadedAttachment[];
  status: "sending" | "failed";
};

/** The most files one message can carry (the API's `MAX_ATTACHMENTS_PER_MESSAGE`). */
export const CHAT_MAX_ATTACHMENTS = 10;

export type TChatOutgoingMessage = Pick<TChatMessageWrite, "body_html" | "body_json"> & {
  attachments?: TChatUploadedAttachment[];
};

/** What to search for besides the words: one channel or DM, one person, and whether automatic messages count. */
export type TChatSearchFilters = {
  channelId?: string;
  senderId?: string;
  /** Leave out automatic messages. */
  excludeAutomatic?: boolean;
};

/** The latest search and its results, newest first. Results are a snapshot: they don't follow live updates. */
export type TChatSearch = {
  query: string;
  filters: TChatSearchFilters;
  results: TChatSearchResult[];
  hasMore: boolean;
  /** The first page is on its way. */
  loading: boolean;
  loadingMore: boolean;
  /** The first page failed. */
  error: boolean;
  /** The last try at a further page failed; the panel offers a retry. */
  moreFailed: boolean;
};

/** The API refuses shorter searches (`MIN_QUERY_LENGTH`), and the panel doesn't send them. */
export const CHAT_SEARCH_MIN_LENGTH = 2;
/** The API refuses longer ones (`MAX_QUERY_LENGTH`). */
export const CHAT_SEARCH_MAX_LENGTH = 200;
const CHAT_SEARCH_PAGE_SIZE = 20;

/** A page fetches this many messages at a time. */
const CHAT_PAGE_SIZE = 50;
/** The catch-up after a reconnect stops after this many pages and reloads the channel instead. */
const MAX_CATCH_UP_PAGES = 20;
/** Following a link to an old message loads back at most this many pages looking for it. */
const REVEAL_MAX_PAGES = 20;

function searchParams(q: string, filters: TChatSearchFilters) {
  return {
    q,
    limit: CHAT_SEARCH_PAGE_SIZE,
    ...(filters.channelId ? { channel: filters.channelId } : {}),
    ...(filters.senderId ? { sender: filters.senderId } : {}),
    ...(filters.excludeAutomatic ? { automatic: false } : {}),
  };
}

const isNotFound = (error: unknown) => error instanceof ChatServiceError && error.isNotFound;

const byName = (channels: TChatChannel[]) => sortBy(channels, (channel) => channel.name.toLowerCase());

const byNewestActivity = (channels: TChatChannel[]) =>
  orderBy(channels, (channel) => Date.parse(channel.last_message_at ?? channel.created_at), "desc");

/**
 * `(created_at, id)`, the order the API pages in. Timestamps are compared as instants: REST answers in the user's
 * timezone and events in UTC, so the same moment can be written differently.
 */
const inMessageOrder = (messages: TChatMessage[]) => sortBy(messages, [(m) => Date.parse(m.created_at), "id"]);

const isBefore = (a: TChatMessage, b: TChatMessage) => {
  const [aAt, bAt] = [Date.parse(a.created_at), Date.parse(b.created_at)];
  return aAt < bAt || (aAt === bAt && a.id < b.id);
};

const emptyMessages = (): TChatChannelMessages => ({
  ids: [],
  hasMoreOlder: false,
  loaded: false,
  loading: false,
  loadingOlder: false,
  olderFailed: false,
  error: false,
});

const defaultSocketFactory: TChatSocketFactory = (workspaceSlug, handlers) =>
  new ChatSocket({ workspaceSlug, ...handlers });

export interface IChatStore {
  // observables
  workspaceSlug: string | null;
  userId: string | null;
  me: TChatMe | null;
  channelMap: Record<string, TChatChannel>;
  messageMap: Record<string, TChatMessage>;
  channelMessages: Record<string, TChatChannelMessages>;
  pendingMessages: Record<string, TChatPendingMessage[]>;
  threadMessages: Record<string, TChatThreadMessages>;
  pendingReplies: Record<string, TChatPendingMessage[]>;
  activeChannelId: string | null;
  activeThread: TChatActiveThread | null;
  search: TChatSearch | null;
  isDocumentVisible: boolean;
  /** The open channel's list is scrolled to its newest message. */
  isAtNewest: boolean;
  channelsLoaded: boolean;
  channelsError: boolean;
  socketStatus: TChatSocketStatus;
  socketClosedReason: TChatSocketClosedReason | null;
  // computed
  joinedChannels: TChatChannel[];
  browsableChannels: TChatChannel[];
  directMessages: TChatChannel[];
  totalUnread: number;
  activeChannel: TChatChannel | undefined;
  // helpers
  getChannelMessages: (channelId: string) => TChatMessage[];
  getMessagesState: (channelId: string) => TChatChannelMessages | undefined;
  getPendingMessages: (channelId: string) => TChatPendingMessage[];
  /** Unsent text, by channel ID, or `<channel ID>/<thread ID>` for a thread's reply box. */
  getDraft: (key: string) => string | undefined;
  setDraft: (key: string, html: string) => void;
  getThreadReplies: (parentId: string) => TChatMessage[];
  getThreadState: (parentId: string) => TChatThreadMessages | undefined;
  getPendingReplies: (parentId: string) => TChatPendingMessage[];
  // actions
  start: (workspaceSlug: string, userId: string) => Promise<void>;
  stop: () => void;
  fetchChannels: () => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  closeChannel: () => void;
  setDocumentVisible: (visible: boolean) => void;
  setAtNewest: (channelId: string, atNewest: boolean) => void;
  loadOlderMessages: (channelId: string) => Promise<void>;
  revealMessage: (channelId: string, messageId: string) => Promise<boolean>;
  openThread: (channelId: string, parentId: string) => Promise<void>;
  closeThread: () => void;
  loadOlderReplies: (parentId: string) => Promise<void>;
  revealReply: (parentId: string, replyId: string) => Promise<boolean>;
  searchMessages: (query: string, filters?: TChatSearchFilters) => Promise<void>;
  loadMoreSearchResults: () => Promise<void>;
  clearSearch: () => void;
  sendMessage: (channelId: string, body: TChatOutgoingMessage) => Promise<void>;
  sendReply: (channelId: string, parentId: string, body: TChatOutgoingMessage) => Promise<void>;
  retryMessage: (channelId: string, localId: string) => Promise<void>;
  discardMessage: (channelId: string, localId: string) => void;
  editMessage: (channelId: string, messageId: string, body: TChatMessageEdit) => Promise<void>;
  removeMessage: (channelId: string, messageId: string) => Promise<void>;
  uploadAttachment: (
    channelId: string,
    file: File,
    onProgress?: (percent: number) => void
  ) => Promise<TChatUploadedAttachment>;
  deleteAttachment: (channelId: string, attachmentId: string) => void;
  linkWorkItem: (channelId: string, messageId: string, issueId: string) => Promise<void>;
  markRead: (channelId: string) => Promise<void>;
  createChannel: (data: TChatChannelCreate) => Promise<TChatChannel>;
  updateChannel: (channelId: string, data: TChatChannelUpdate) => Promise<TChatChannel>;
  openDm: (memberIds: string[]) => Promise<TChatChannel>;
  joinChannel: (channelId: string) => Promise<void>;
  leaveChannel: (channelId: string) => Promise<void>;
  reconnect: () => void;
  noteActivity: () => void;
}

/**
 * Nexus Messages in the web app. It owns the chat gateway socket for one workspace and mirrors the chat REST API:
 * the socket only says that something changed, and the store fetches it over REST, where permissions are enforced.
 *
 * - Every `ready` (the first, and after every reconnect) and every `resync` refetch the channel list and catch up
 *   each loaded channel with `messages/?after=<newest id held when events stopped>`, then re-read its newest page
 *   for edits and removals.
 * - The first the user hears of a new channel or DM is their own `member.added`: the channel is fetched then.
 * - A public channel the user is viewing but hasn't joined is `subscribe`d explicitly, and again after their own
 *   `member.removed`.
 * - Writes go through REST. A sent message shows as pending until the API returns it; its event is then a no-op.
 * - Thread replies stay out of the channel's list and out of its unread count, like the API's. The open thread holds
 *   its replies the way a channel holds its messages, and is caught up the same way. A reply's event re-reads its
 *   parent, whose summary (`reply_count`, `last_reply_at`) changed; after a reconnect, only the parents on the
 *   channel's newest page and the open thread's are re-read.
 */
export class ChatStore implements IChatStore {
  workspaceSlug: string | null = null;
  userId: string | null = null;
  me: TChatMe | null = null;
  channelMap: Record<string, TChatChannel> = {};
  messageMap: Record<string, TChatMessage> = {};
  channelMessages: Record<string, TChatChannelMessages> = {};
  pendingMessages: Record<string, TChatPendingMessage[]> = {};
  /** By the thread's first message. */
  threadMessages: Record<string, TChatThreadMessages> = {};
  /** By the thread's first message. Kept when the thread closes, so a failed reply is still there to retry. */
  pendingReplies: Record<string, TChatPendingMessage[]> = {};
  activeChannelId: string | null = null;
  activeThread: TChatActiveThread | null = null;
  search: TChatSearch | null = null;
  isDocumentVisible = true;
  isAtNewest = true;
  channelsLoaded = false;
  channelsError = false;
  socketStatus: TChatSocketStatus = "idle";
  socketClosedReason: TChatSocketClosedReason | null = null;

  private readonly service: TChatStoreService;
  private readonly createSocket: TChatSocketFactory;
  private socket: TChatStoreSocket | null = null;
  /** Bumped on every start/stop, so answers for a previous workspace are dropped. */
  private generation = 0;
  private localIds = 0;
  private readonly channelRefreshes = new Map<string, { again: boolean; promise: Promise<void> }>();
  private readonly readsInFlight = new Map<string, { again: boolean; promise: Promise<void> }>();
  private readonly messageLoads = new Map<string, { again: boolean; promise: Promise<void> }>();
  private readonly channelLists = new Map<string, { again: boolean; promise: Promise<void> }>();
  /** Channels changed since the running list request began; its answer is older than these. */
  private readonly changedDuringList = new Set<string>();
  /** Where each channel's unbroken history ends, from the moment events may have been missed until it's caught up. */
  private readonly catchUpCursors = new Map<string, string>();
  private readonly olderPages = new Map<string, Promise<void>>();
  private readonly threadLoads = new Map<string, { again: boolean; promise: Promise<void> }>();
  private readonly olderReplyPages = new Map<string, Promise<void>>();
  /** Like `catchUpCursors`, by the thread's first message. */
  private readonly threadCatchUpCursors = new Map<string, string>();
  private readonly messageRefetches = new Map<string, { again: boolean; promise: Promise<void> }>();
  private resyncing: { again: boolean; promise: Promise<void> } | null = null;
  /** Unsent composer HTML per channel. Not observable: the composer reads it once, when it mounts. */
  private readonly drafts = new Map<string, string>();
  /** Bumped by every new search, so an answer to an older one is dropped. */
  private searchGeneration = 0;

  constructor(options: { service?: TChatStoreService; createSocket?: TChatSocketFactory } = {}) {
    makeObservable<
      ChatStore,
      "upsertChannel" | "removeChannelLocally" | "upsertMessages" | "upsertReplies" | "handleEvent"
    >(this, {
      // observables
      workspaceSlug: observable.ref,
      userId: observable.ref,
      me: observable.ref,
      channelMap: observable,
      messageMap: observable,
      channelMessages: observable,
      pendingMessages: observable,
      threadMessages: observable,
      pendingReplies: observable,
      activeChannelId: observable.ref,
      activeThread: observable.ref,
      search: observable.ref,
      isDocumentVisible: observable.ref,
      isAtNewest: observable.ref,
      channelsLoaded: observable.ref,
      channelsError: observable.ref,
      socketStatus: observable.ref,
      socketClosedReason: observable.ref,
      // computed
      joinedChannels: computed,
      browsableChannels: computed,
      directMessages: computed,
      totalUnread: computed,
      activeChannel: computed,
      // actions, bound so components can destructure them from useChat()
      start: action.bound,
      stop: action.bound,
      fetchChannels: action.bound,
      openChannel: action.bound,
      closeChannel: action.bound,
      setDocumentVisible: action.bound,
      setAtNewest: action.bound,
      loadOlderMessages: action.bound,
      revealMessage: action.bound,
      openThread: action.bound,
      closeThread: action.bound,
      loadOlderReplies: action.bound,
      revealReply: action.bound,
      searchMessages: action.bound,
      loadMoreSearchResults: action.bound,
      clearSearch: action.bound,
      sendMessage: action.bound,
      sendReply: action.bound,
      retryMessage: action.bound,
      discardMessage: action.bound,
      editMessage: action.bound,
      removeMessage: action.bound,
      uploadAttachment: action.bound,
      deleteAttachment: action.bound,
      linkWorkItem: action.bound,
      markRead: action.bound,
      createChannel: action.bound,
      updateChannel: action.bound,
      openDm: action.bound,
      joinChannel: action.bound,
      leaveChannel: action.bound,
      reconnect: action.bound,
      noteActivity: action.bound,
      upsertChannel: action,
      removeChannelLocally: action,
      upsertMessages: action,
      upsertReplies: action,
      handleEvent: action,
    });
    this.service = options.service ?? new ChatService();
    this.createSocket = options.createSocket ?? defaultSocketFactory;
  }

  // computed

  /** Public and private channels the user is in, by name. */
  get joinedChannels(): TChatChannel[] {
    return byName(
      Object.values(this.channelMap).filter(
        (channel) =>
          (channel.kind === "public" || channel.kind === "private") && channel.is_member && !channel.archived_at
      )
    );
  }

  /** Public channels the user can see but hasn't joined, by name. */
  get browsableChannels(): TChatChannel[] {
    return byName(
      Object.values(this.channelMap).filter(
        (channel) => channel.kind === "public" && !channel.is_member && !channel.archived_at
      )
    );
  }

  /** DMs and group DMs, most recent activity first. */
  get directMessages(): TChatChannel[] {
    return byNewestActivity(
      Object.values(this.channelMap).filter(
        (channel) => (channel.kind === "dm" || channel.kind === "group_dm") && !channel.archived_at
      )
    );
  }

  get totalUnread(): number {
    return Object.values(this.channelMap).reduce(
      (total, channel) => total + (channel.is_member && !channel.archived_at ? channel.unread_count : 0),
      0
    );
  }

  get activeChannel(): TChatChannel | undefined {
    return this.activeChannelId ? this.channelMap[this.activeChannelId] : undefined;
  }

  // helpers

  getChannelMessages = (channelId: string): TChatMessage[] =>
    (this.channelMessages[channelId]?.ids ?? []).map((id) => this.messageMap[id]).filter((m): m is TChatMessage => !!m);

  getMessagesState = (channelId: string): TChatChannelMessages | undefined => this.channelMessages[channelId];

  getPendingMessages = (channelId: string): TChatPendingMessage[] => this.pendingMessages[channelId] ?? [];

  /** A thread's replies, oldest first. Removed ones are left out: unlike the channel's, nothing hangs off them. */
  getThreadReplies = (parentId: string): TChatMessage[] =>
    (this.threadMessages[parentId]?.ids ?? [])
      .map((id) => this.messageMap[id])
      .filter((m): m is TChatMessage => !!m && !m.removed_at);

  getThreadState = (parentId: string): TChatThreadMessages | undefined => this.threadMessages[parentId];

  getPendingReplies = (parentId: string): TChatPendingMessage[] => this.pendingReplies[parentId] ?? [];

  getDraft = (channelId: string): string | undefined => this.drafts.get(channelId);

  /** An empty `html` forgets the draft. */
  setDraft = (channelId: string, html: string): void => {
    if (html) this.drafts.set(channelId, html);
    else this.drafts.delete(channelId);
  };

  /** The user can see the channel's newest messages: it is open, the tab is visible, and the list is at the bottom. */
  private isViewing(channelId: string): boolean {
    return this.activeChannelId === channelId && this.isDocumentVisible && this.isAtNewest;
  }

  /** Runs `fn` only if the store is still on the workspace it was on when the request started. */
  private guard(): (fn: () => void) => void {
    const generation = this.generation;
    return (fn) => {
      if (generation === this.generation) runInAction(fn);
    };
  }

  // lifecycle

  async start(workspaceSlug: string, userId: string): Promise<void> {
    if (this.workspaceSlug === workspaceSlug && this.userId === userId && this.socket) return;
    this.stop();
    this.generation += 1;
    this.workspaceSlug = workspaceSlug;
    this.userId = userId;
    this.socket = this.createSocket(workspaceSlug, {
      onReady: () => void this.resync(),
      onResync: () => void this.resync(),
      onEvent: (event) => this.handleEvent(event),
      onStatusChange: (status, closedReason) =>
        runInAction(() => {
          this.socketStatus = status;
          this.socketClosedReason = closedReason;
          // Events just stopped, so what's held now is unbroken. A send landing before `ready` mustn't move this.
          if (status === "paused" || status === "reconnecting") this.noteCatchUpCursors();
        }),
    });
    this.socket.connect();
    const commit = this.guard();
    const [me] = await Promise.allSettled([this.service.me(workspaceSlug), this.fetchChannels()]);
    if (me.status === "fulfilled") commit(() => (this.me = me.value));
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    this.generation += 1;
    this.workspaceSlug = null;
    this.userId = null;
    this.me = null;
    this.channelMap = {};
    this.messageMap = {};
    this.channelMessages = {};
    this.pendingMessages = {};
    this.threadMessages = {};
    this.pendingReplies = {};
    this.activeChannelId = null;
    this.isAtNewest = true;
    this.activeThread = null;
    this.search = null;
    this.searchGeneration += 1;
    this.channelsLoaded = false;
    this.channelsError = false;
    this.socketStatus = "idle";
    this.socketClosedReason = null;
    this.channelRefreshes.clear();
    this.readsInFlight.clear();
    this.messageLoads.clear();
    this.channelLists.clear();
    this.changedDuringList.clear();
    this.catchUpCursors.clear();
    this.resyncing = null;
    this.olderPages.clear();
    this.drafts.clear();
    this.threadLoads.clear();
    this.olderReplyPages.clear();
    this.threadCatchUpCursors.clear();
    this.messageRefetches.clear();
  }

  /** Try the socket again now, e.g. from a "reconnect" button or when the browser comes back online. */
  reconnect(): void {
    this.socket?.reconnectNow();
  }

  /** The user did something: keeps the socket from going idle, and reopens it if it already has. */
  noteActivity(): void {
    this.socket?.noteActivity();
  }

  // channels

  fetchChannels(): Promise<void> {
    return this.coalesce(this.channelLists, "list", async () => {
      const slug = this.workspaceSlug;
      if (!slug) return;
      const commit = this.guard();
      this.changedDuringList.clear();
      try {
        const channels = await this.service.listChannels(slug);
        let recheck: string | undefined;
        commit(() => {
          const next: Record<string, TChatChannel> = {};
          for (const channel of channels) next[channel.id] = channel;
          for (const id of this.changedDuringList) {
            const current = this.channelMap[id];
            if (current) next[id] = current;
            else delete next[id];
          }
          // The list has live channels only. The open one stays until a re-read says whether it was archived
          // (still readable) or is gone.
          const active = this.activeChannelId ? this.channelMap[this.activeChannelId] : undefined;
          if (active && !next[active.id]) {
            next[active.id] = active;
            recheck = active.id;
          }
          for (const [id, previous] of Object.entries(this.channelMap)) {
            if (!next[id]) this.dropChannelState(id);
            else if (previous.is_member && !next[id]!.is_member && id !== this.activeChannelId)
              this.dropChannelState(id);
          }
          this.channelMap = next;
          this.channelsLoaded = true;
          this.channelsError = false;
        });
        if (recheck) await this.refreshChannel(recheck);
      } catch {
        commit(() => (this.channelsError = true));
      }
    });
  }

  private upsertChannel(channel: TChatChannel): void {
    const previous = this.channelMap[channel.id];
    this.channelMap[channel.id] = channel;
    this.changedDuringList.add(channel.id);
    if (channel.is_member) {
      // The gateway follows member channels on its own.
      if (previous && !previous.is_member) this.socket?.unsubscribe(channel.id);
    } else if (channel.kind === "public" && this.activeChannelId === channel.id) {
      // Still browsing it without being in it (e.g. just left): follow it explicitly, again.
      this.socket?.subscribe(channel.id);
    } else if (previous?.is_member && this.activeChannelId !== channel.id) {
      // Left while looking elsewhere: nothing follows it now, so what we hold would go stale.
      this.dropChannelState(channel.id);
    }
  }

  private removeChannelLocally(channelId: string): void {
    delete this.channelMap[channelId];
    this.changedDuringList.add(channelId);
    this.dropChannelState(channelId);
    if (this.activeChannelId === channelId) this.socket?.unsubscribe(channelId);
  }

  private dropChannelState(channelId: string): void {
    if (this.activeThread?.channelId === channelId) this.activeThread = null;
    for (const [parentId, thread] of Object.entries(this.threadMessages)) {
      if (thread.channelId === channelId) this.dropThreadState(parentId);
    }
    for (const [parentId, replies] of Object.entries(this.pendingReplies)) {
      if (replies.some((reply) => reply.channelId === channelId)) delete this.pendingReplies[parentId];
    }
    for (const id of this.channelMessages[channelId]?.ids ?? []) delete this.messageMap[id];
    delete this.channelMessages[channelId];
    delete this.pendingMessages[channelId];
    this.catchUpCursors.delete(channelId);
  }

  /** Forget a thread's replies, and its first message unless the channel's list holds that too. */
  private dropThreadState(parentId: string): void {
    const thread = this.threadMessages[parentId];
    for (const id of thread?.ids ?? []) delete this.messageMap[id];
    const channelId = thread?.channelId ?? this.messageMap[parentId]?.channel;
    if (channelId && !this.channelMessages[channelId]?.ids.includes(parentId)) delete this.messageMap[parentId];
    delete this.threadMessages[parentId];
    this.threadCatchUpCursors.delete(parentId);
  }

  /** Re-read one channel. Calls for the same channel while one is in flight collapse into one more read. */
  private refreshChannel(channelId: string): Promise<void> {
    return this.coalesce(this.channelRefreshes, channelId, async () => {
      const slug = this.workspaceSlug;
      if (!slug) return;
      const commit = this.guard();
      try {
        const channel = await this.service.getChannel(slug, channelId);
        commit(() => this.upsertChannel(channel));
      } catch (error) {
        // Gone, or no longer visible: the API doesn't say which, and it doesn't matter here.
        if (isNotFound(error)) commit(() => this.removeChannelLocally(channelId));
      }
    });
  }

  private coalesce(
    running: Map<string, { again: boolean; promise: Promise<void> }>,
    key: string,
    work: () => Promise<void>
  ): Promise<void> {
    const current = running.get(key);
    if (current) {
      current.again = true;
      return current.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          // oxlint-disable-next-line no-await-in-loop -- one more run only after the previous one finished
          await work();
        } while (entry.again);
      } finally {
        if (running.get(key) === entry) running.delete(key);
      }
    })();
    running.set(key, entry);
    return entry.promise;
  }

  async openChannel(channelId: string): Promise<void> {
    const slug = this.workspaceSlug;
    if (!slug) return;
    const previous = this.activeChannelId;
    if (previous && previous !== channelId) this.closeChannel();
    this.activeChannelId = channelId;
    const commit = this.guard();
    let channel = this.channelMap[channelId];
    if (!channel) {
      try {
        channel = await this.service.getChannel(slug, channelId);
        commit(() => this.upsertChannel(channel!));
      } catch (error) {
        if (isNotFound(error)) commit(() => this.removeChannelLocally(channelId));
        throw error;
      }
    }
    if (!channel.is_member && channel.kind === "public" && this.activeChannelId === channelId) {
      this.socket?.subscribe(channelId);
    }
    if (!this.channelMessages[channelId]?.loaded) await this.loadNewestMessages(channelId);
    if (this.isViewing(channelId)) await this.markRead(channelId);
  }

  closeChannel(): void {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    if (this.activeThread?.channelId === channelId) this.closeThread();
    this.activeChannelId = null;
    // A channel opens at its newest messages.
    this.isAtNewest = true;
    const channel = this.channelMap[channelId];
    if (channel && !channel.is_member) {
      this.socket?.unsubscribe(channelId);
      // Not followed any more, so what we hold would go stale.
      this.dropChannelState(channelId);
    }
  }

  setDocumentVisible(visible: boolean): void {
    this.isDocumentVisible = visible;
    if (this.activeChannelId && this.isViewing(this.activeChannelId)) void this.markRead(this.activeChannelId);
  }

  /** The message list says whether it is scrolled to the newest message. Reaching it marks the channel read. */
  setAtNewest(channelId: string, atNewest: boolean): void {
    if (this.activeChannelId !== channelId || this.isAtNewest === atNewest) return;
    this.isAtNewest = atNewest;
    if (this.isViewing(channelId)) void this.markRead(channelId);
  }

  async createChannel(data: TChatChannelCreate): Promise<TChatChannel> {
    const slug = this.requireSlug();
    const commit = this.guard();
    const channel = await this.service.createChannel(slug, data);
    commit(() => this.upsertChannel(channel));
    return channel;
  }

  /** Rename a channel, edit its description, or link or unlink its project. */
  async updateChannel(channelId: string, data: TChatChannelUpdate): Promise<TChatChannel> {
    const slug = this.requireSlug();
    const commit = this.guard();
    const channel = await this.service.updateChannel(slug, channelId, data);
    commit(() => this.upsertChannel(channel));
    return channel;
  }

  async openDm(memberIds: string[]): Promise<TChatChannel> {
    const slug = this.requireSlug();
    const commit = this.guard();
    const channel = await this.service.openDm(slug, memberIds);
    commit(() => this.upsertChannel(channel));
    return channel;
  }

  async joinChannel(channelId: string): Promise<void> {
    const slug = this.requireSlug();
    const commit = this.guard();
    const channel = await this.service.joinChannel(slug, channelId);
    commit(() => this.upsertChannel(channel));
  }

  async leaveChannel(channelId: string): Promise<void> {
    const slug = this.requireSlug();
    await this.service.leaveChannel(slug, channelId);
    await this.refreshChannel(channelId);
  }

  private requireSlug(): string {
    if (!this.workspaceSlug) throw new Error("ChatStore: not started");
    return this.workspaceSlug;
  }

  // messages

  /**
   * The channel's message state, created if needed. Read back after assigning: MobX stores an observable copy, so
   * writes through the object that was assigned would be lost.
   */
  private messagesState(channelId: string): TChatChannelMessages {
    if (!this.channelMessages[channelId]) this.channelMessages[channelId] = emptyMessages();
    return this.channelMessages[channelId]!;
  }

  /** Keep `message` unless a newer copy is already held: re-reads of one message can answer out of order. */
  private holdMessage(message: TChatMessage): void {
    const held = this.messageMap[message.id];
    if (!held || Date.parse(message.updated_at) >= Date.parse(held.updated_at)) this.messageMap[message.id] = message;
  }

  private upsertMessages(channelId: string, messages: TChatMessage[], position: "older" | "newer"): void {
    this.placeMessages(this.messagesState(channelId), messages, position, (message) => !message.parent);
  }

  /** Into the thread's list if it is held. A thread that isn't open holds nothing, so nothing goes stale. */
  private upsertReplies(parentId: string, messages: TChatMessage[], position: "older" | "newer"): void {
    const state = this.threadMessages[parentId];
    if (state) this.placeMessages(state, messages, position, (message) => message.parent === parentId);
  }

  /** Hold `messages`, and add those that `belong` and are new to `state`'s list, in `(created_at, id)` order. */
  private placeMessages(
    state: TChatChannelMessages,
    messages: TChatMessage[],
    position: "older" | "newer",
    belongs: (message: TChatMessage) => boolean
  ): void {
    const known = new Set(state.ids);
    // Before the oldest message loaded, with older pages still to load, a message isn't part of what is shown (a
    // thread's first message, fetched on its own): listing it would make the next older page start before it and
    // skip everything in between. It is held, and its page brings it in.
    const first =
      position === "newer" && state.hasMoreOlder && state.ids.length ? this.messageMap[state.ids[0]!] : undefined;
    const fresh: TChatMessage[] = [];
    for (const message of messages) {
      this.holdMessage(message);
      if (!known.has(message.id) && belongs(message) && !(first && isBefore(message, first))) fresh.push(message);
    }
    if (fresh.length === 0) return;
    if (position === "older") {
      state.ids = [...fresh.map((m) => m.id), ...state.ids];
      return;
    }
    // Newer messages normally just go on the end; sort only when they don't (a slow fetch landing late).
    const last = state.ids.length ? this.messageMap[state.ids[state.ids.length - 1]!] : undefined;
    const ordered = inMessageOrder(fresh);
    if (!last || isBefore(last, ordered[0]!)) {
      state.ids = [...state.ids, ...ordered.map((m) => m.id)];
      return;
    }
    state.ids = inMessageOrder([...state.ids.map((id) => this.messageMap[id]!), ...ordered]).map((m) => m.id);
  }

  /** Overlapping loads share one, and a message that arrives during a load asks for one more (see `fetchMessage`). */
  private loadNewestMessages(channelId: string): Promise<void> {
    return this.coalesce(this.messageLoads, channelId, async () => {
      const slug = this.workspaceSlug;
      if (!slug) return;
      const commit = this.guard();
      commit(() => {
        const state = this.messagesState(channelId);
        state.loading = true;
        state.error = false;
      });
      try {
        const page = await this.service.listMessages(slug, channelId, { limit: CHAT_PAGE_SIZE });
        commit(() => {
          this.catchUpCursors.delete(channelId);
          const channel = this.channelMap[channelId];
          if (channel && !channel.is_member && this.activeChannelId !== channelId) {
            // Closed while this was loading: nothing follows it now, so keeping the page would go stale.
            this.dropChannelState(channelId);
            return;
          }
          // A fresh start: whatever was held may not be contiguous with this page.
          this.channelMessages[channelId] = { ...emptyMessages(), loaded: true, hasMoreOlder: page.has_more };
          this.upsertMessages(channelId, page.results, "newer");
        });
      } catch (error) {
        commit(() => {
          const state = this.channelMessages[channelId];
          if (state) {
            state.loading = false;
            state.error = true;
          }
          if (isNotFound(error)) this.removeChannelLocally(channelId);
        });
      }
    });
  }

  /** The page already on its way if there is one, so someone waiting on it can tell when it has landed. */
  loadOlderMessages(channelId: string): Promise<void> {
    const running = this.olderPages.get(channelId);
    if (running) return running;
    const page = this.fetchOlderMessages(channelId).finally(() => {
      if (this.olderPages.get(channelId) === page) this.olderPages.delete(channelId);
    });
    this.olderPages.set(channelId, page);
    return page;
  }

  /** Load back through the channel until `messageId` is there. False if it isn't within `REVEAL_MAX_PAGES` pages, or a page failed. */
  async revealMessage(channelId: string, messageId: string): Promise<boolean> {
    const isLoaded = () => !!this.channelMessages[channelId]?.ids.includes(messageId);
    for (let page = 0; page < REVEAL_MAX_PAGES && !isLoaded(); page += 1) {
      if (!this.channelMessages[channelId]?.hasMoreOlder) return false;
      // oxlint-disable-next-line no-await-in-loop -- each page's cursor comes from the one before it
      await this.loadOlderMessages(channelId);
      // The list offers a retry for this, so don't keep asking from here.
      if (this.channelMessages[channelId]?.olderFailed) return false;
    }
    return isLoaded();
  }

  private async fetchOlderMessages(channelId: string): Promise<void> {
    const slug = this.workspaceSlug;
    const state = this.channelMessages[channelId];
    if (!slug || !state?.loaded || !state.hasMoreOlder || state.loadingOlder || state.ids.length === 0) return;
    state.loadingOlder = true;
    state.olderFailed = false;
    const commit = this.guard();
    try {
      const page = await this.service.listMessages(slug, channelId, { before: state.ids[0], limit: CHAT_PAGE_SIZE });
      commit(() => {
        const current = this.channelMessages[channelId];
        if (!current) return;
        current.loadingOlder = false;
        current.hasMoreOlder = page.has_more;
        this.upsertMessages(channelId, page.results, "older");
      });
    } catch {
      commit(() => {
        const current = this.channelMessages[channelId];
        if (current) {
          current.loadingOlder = false;
          current.olderFailed = true;
        }
      });
    }
  }

  /** Fetch one message and put it where it belongs, if the channel's messages are loaded. */
  private async fetchMessage(channelId: string, messageId: string): Promise<void> {
    const slug = this.workspaceSlug;
    const state = this.channelMessages[channelId];
    if (!slug || !state) return;
    if (state.loading) {
      // The page in flight may have been read before this message existed, and it replaces what's held.
      await this.loadNewestMessages(channelId);
      return;
    }
    if (!state.loaded) return;
    const commit = this.guard();
    try {
      const message = await this.service.getMessage(slug, channelId, messageId);
      commit(() => {
        if (this.channelMessages[channelId]?.loaded) this.upsertMessages(channelId, [message], "newer");
      });
    } catch (error) {
      if (isNotFound(error)) void this.refreshChannel(channelId);
    }
  }

  // threads

  /**
   * Open a thread beside the conversation: its first message (fetched if the channel's list doesn't hold it, as when
   * following a link) and its newest page of replies. Opening another thread closes this one.
   */
  async openThread(channelId: string, parentId: string): Promise<void> {
    const slug = this.workspaceSlug;
    if (!slug) return;
    if (this.activeThread?.parentId !== parentId) {
      this.closeThread();
      this.activeThread = { channelId, parentId };
    }
    // Already open: only what failed is asked for again.
    const state = this.threadMessages[parentId];
    const loads: Promise<void>[] = [];
    if (!state?.loaded && !state?.loading) loads.push(this.loadNewestReplies(channelId, parentId));
    if (!this.messageMap[parentId]) loads.push(this.fetchThreadParent(channelId, parentId));
    await Promise.all(loads);
  }

  closeThread(): void {
    const parentId = this.activeThread?.parentId;
    if (!parentId) return;
    this.activeThread = null;
    this.dropThreadState(parentId);
  }

  private isThreadOpen(parentId: string): boolean {
    return this.activeThread?.parentId === parentId;
  }

  private threadState(channelId: string, parentId: string): TChatThreadMessages {
    if (!this.threadMessages[parentId]) this.threadMessages[parentId] = { ...emptyMessages(), channelId };
    return this.threadMessages[parentId]!;
  }

  private async fetchThreadParent(channelId: string, parentId: string): Promise<void> {
    const slug = this.workspaceSlug;
    if (!slug) return;
    const commit = this.guard();
    try {
      const parent = await this.service.getMessage(slug, channelId, parentId);
      commit(() => {
        if (this.isThreadOpen(parentId)) this.holdMessage(parent);
      });
    } catch {
      // The panel offers a retry. The replies' page may well have loaded, so say so on the thread's state.
      commit(() => {
        if (this.isThreadOpen(parentId)) this.threadState(channelId, parentId).error = true;
      });
    }
  }

  /** Like `loadNewestMessages`, for the open thread. */
  private loadNewestReplies(channelId: string, parentId: string): Promise<void> {
    return this.coalesce(this.threadLoads, parentId, async () => {
      const slug = this.workspaceSlug;
      if (!slug || !this.isThreadOpen(parentId)) return;
      const commit = this.guard();
      commit(() => {
        const state = this.threadState(channelId, parentId);
        state.loading = true;
        state.error = false;
      });
      try {
        const page = await this.service.listReplies(slug, channelId, parentId, { limit: CHAT_PAGE_SIZE });
        commit(() => {
          this.threadCatchUpCursors.delete(parentId);
          if (!this.isThreadOpen(parentId)) return;
          this.threadMessages[parentId] = { ...emptyMessages(), channelId, loaded: true, hasMoreOlder: page.has_more };
          this.upsertReplies(parentId, page.results, "newer");
        });
      } catch {
        commit(() => {
          const state = this.threadMessages[parentId];
          if (state) {
            state.loading = false;
            state.error = true;
          }
        });
      }
    });
  }

  loadOlderReplies(parentId: string): Promise<void> {
    const running = this.olderReplyPages.get(parentId);
    if (running) return running;
    const page = this.fetchOlderReplies(parentId).finally(() => {
      if (this.olderReplyPages.get(parentId) === page) this.olderReplyPages.delete(parentId);
    });
    this.olderReplyPages.set(parentId, page);
    return page;
  }

  private async fetchOlderReplies(parentId: string): Promise<void> {
    const slug = this.workspaceSlug;
    const state = this.threadMessages[parentId];
    if (!slug || !state?.loaded || !state.hasMoreOlder || state.loadingOlder || state.ids.length === 0) return;
    state.loadingOlder = true;
    state.olderFailed = false;
    const commit = this.guard();
    try {
      const page = await this.service.listReplies(slug, state.channelId, parentId, {
        before: state.ids[0],
        limit: CHAT_PAGE_SIZE,
      });
      commit(() => {
        const current = this.threadMessages[parentId];
        if (!current) return;
        current.loadingOlder = false;
        current.hasMoreOlder = page.has_more;
        this.upsertReplies(parentId, page.results, "older");
      });
    } catch {
      commit(() => {
        const current = this.threadMessages[parentId];
        if (current) {
          current.loadingOlder = false;
          current.olderFailed = true;
        }
      });
    }
  }

  /** Like `revealMessage`, in the open thread. A removed reply isn't shown, so it can't be revealed. */
  async revealReply(parentId: string, replyId: string): Promise<boolean> {
    const isLoaded = () => !!this.threadMessages[parentId]?.ids.includes(replyId);
    for (let page = 0; page < REVEAL_MAX_PAGES && !isLoaded(); page += 1) {
      if (!this.threadMessages[parentId]?.hasMoreOlder) return false;
      // oxlint-disable-next-line no-await-in-loop -- each page's cursor comes from the one before it
      await this.loadOlderReplies(parentId);
      if (this.threadMessages[parentId]?.olderFailed) return false;
    }
    return isLoaded() && !this.messageMap[replyId]?.removed_at;
  }

  /** Like `fetchMessage`, for a reply in the open thread. */
  private async fetchReply(channelId: string, parentId: string, replyId: string): Promise<void> {
    const slug = this.workspaceSlug;
    const state = this.threadMessages[parentId];
    if (!slug || !state) return;
    if (state.loading) {
      await this.loadNewestReplies(channelId, parentId);
      return;
    }
    if (!state.loaded) return;
    const commit = this.guard();
    try {
      const reply = await this.service.getMessage(slug, channelId, replyId);
      commit(() => {
        if (this.threadMessages[parentId]?.loaded) this.upsertReplies(parentId, [reply], "newer");
      });
    } catch {
      // Removed for good, or the channel went: its own events or the next resync say so.
    }
  }

  // search

  /** Search the messages the user may read. A newer search replaces this one, and an older answer is dropped. */
  async searchMessages(query: string, filters: TChatSearchFilters = {}): Promise<void> {
    const workspaceSlug = this.workspaceSlug;
    const q = query.trim();
    if (!workspaceSlug || q.length < CHAT_SEARCH_MIN_LENGTH) return this.clearSearch();
    const generation = ++this.searchGeneration;
    this.search = {
      query: q,
      filters,
      results: [],
      hasMore: false,
      loading: true,
      loadingMore: false,
      error: false,
      moreFailed: false,
    };
    const commit = this.searchGuard(generation);
    try {
      const page = await this.service.searchMessages(workspaceSlug, searchParams(q, filters));
      commit((search) => ({ ...search, results: page.results, hasMore: page.has_more, loading: false }));
    } catch {
      commit((search) => ({ ...search, loading: false, error: true }));
    }
  }

  /** The results just older than those held. */
  async loadMoreSearchResults(): Promise<void> {
    const workspaceSlug = this.workspaceSlug;
    const search = this.search;
    const last = search?.results[search.results.length - 1];
    if (!workspaceSlug || !search || !last || !search.hasMore || search.loading || search.loadingMore) return;
    this.search = { ...search, loadingMore: true, moreFailed: false };
    const commit = this.searchGuard(this.searchGeneration);
    try {
      const page = await this.service.searchMessages(workspaceSlug, {
        ...searchParams(search.query, search.filters),
        before: last.message.id,
      });
      commit((current) => {
        // An edit can move a message between pages; show it once.
        const held = new Set(current.results.map((result) => result.message.id));
        const fresh = page.results.filter((result) => !held.has(result.message.id));
        return { ...current, results: [...current.results, ...fresh], hasMore: page.has_more, loadingMore: false };
      });
    } catch {
      commit((current) => ({ ...current, loadingMore: false, moreFailed: true }));
    }
  }

  clearSearch(): void {
    this.searchGeneration += 1;
    this.search = null;
  }

  /** Applies `update` only while the search started at `generation` is still the current one. */
  private searchGuard(generation: number): (update: (search: TChatSearch) => TChatSearch) => void {
    const guard = this.guard();
    return (update) =>
      guard(() => {
        if (generation === this.searchGeneration && this.search) this.search = update(this.search);
      });
  }

  // sending

  async sendMessage(channelId: string, body: TChatOutgoingMessage): Promise<void> {
    if (!this.pendingMessages[channelId]) this.pendingMessages[channelId] = [];
    this.pendingMessages[channelId]!.push(this.newPending(channelId, null, body));
    await this.deliver(this.pendingMessages[channelId]!.at(-1)!);
  }

  /** Reply in a thread. Shown as pending at the bottom of the thread, with the same retry as a message. */
  async sendReply(channelId: string, parentId: string, body: TChatOutgoingMessage): Promise<void> {
    if (!this.pendingReplies[parentId]) this.pendingReplies[parentId] = [];
    this.pendingReplies[parentId]!.push(this.newPending(channelId, parentId, body));
    await this.deliver(this.pendingReplies[parentId]!.at(-1)!);
  }

  private newPending(channelId: string, parentId: string | null, body: TChatOutgoingMessage): TChatPendingMessage {
    this.localIds += 1;
    return {
      localId: `local-${this.localIds}`,
      channelId,
      parentId,
      body_html: body.body_html,
      body_json: body.body_json ?? {},
      attachments: body.attachments ?? [],
      status: "sending",
    };
  }

  /** A message or reply still on its way, or failed. Local IDs are unique across both. */
  private findPending(channelId: string, localId: string): TChatPendingMessage | undefined {
    const matches = (p: TChatPendingMessage) => p.channelId === channelId && p.localId === localId;
    return this.pendingMessages[channelId]?.find(matches) ?? Object.values(this.pendingReplies).flat().find(matches);
  }

  async retryMessage(channelId: string, localId: string): Promise<void> {
    const pending = this.findPending(channelId, localId);
    if (!pending || pending.status !== "failed") return;
    pending.status = "sending";
    await this.deliver(pending);
  }

  /** Give up on a message that failed to send, and on any files uploaded for it. */
  discardMessage(channelId: string, localId: string): void {
    const pending = this.findPending(channelId, localId);
    if (!pending) return;
    this.forgetPending(pending);
    for (const attachment of pending.attachments) this.deleteAttachment(channelId, attachment.id);
  }

  private forgetPending({ channelId, parentId, localId }: TChatPendingMessage): void {
    const lists = parentId ? this.pendingReplies : this.pendingMessages;
    const key = parentId ?? channelId;
    const list = lists[key];
    if (list) lists[key] = list.filter((p) => p.localId !== localId);
  }

  private async deliver(pending: TChatPendingMessage): Promise<void> {
    this.socket?.noteActivity();
    const slug = this.requireSlug();
    const { channelId, localId, parentId } = pending;
    const commit = this.guard();
    try {
      const message = await this.service.sendMessage(slug, channelId, {
        body_html: pending.body_html,
        body_json: pending.body_json,
        ...(parentId && { parent_id: parentId }),
        ...(pending.attachments.length > 0 && { attachment_ids: pending.attachments.map((file) => file.id) }),
      });
      commit(() => {
        this.forgetPending(pending);
        if (parentId) {
          this.upsertReplies(parentId, [message], "newer");
          return;
        }
        if (this.channelMessages[channelId]?.loaded) this.upsertMessages(channelId, [message], "newer");
        const channel = this.channelMap[channelId];
        if (channel) channel.last_message_at = message.created_at;
      });
      // A reply changes its parent's summary. Its event says so too, but not while the socket is down.
      if (parentId) await this.refetchMessage(channelId, parentId);
      // Sending in a channel means having read it.
      else if (this.activeChannelId === channelId) await this.markRead(channelId);
    } catch (error) {
      commit(() => {
        const current = this.findPending(channelId, localId);
        if (current) current.status = "failed";
      });
      throw error;
    }
  }

  /** Upload a file for a message about to be written. Its ID goes on the message at send time. */
  uploadAttachment(
    channelId: string,
    file: File,
    onProgress?: (percent: number) => void
  ): Promise<TChatUploadedAttachment> {
    return this.service.uploadAttachment(this.requireSlug(), channelId, file, onProgress);
  }

  /** Best effort: an upload nobody sends is also cleaned up on a schedule. */
  deleteAttachment(channelId: string, attachmentId: string): void {
    const slug = this.workspaceSlug;
    if (!slug) return;
    this.service.deleteAttachment(slug, channelId, attachmentId).catch(() => undefined);
  }

  async editMessage(channelId: string, messageId: string, body: TChatMessageEdit): Promise<void> {
    const slug = this.requireSlug();
    const commit = this.guard();
    const message = await this.service.editMessage(slug, channelId, messageId, body);
    commit(() => this.holdMessage(message));
  }

  async removeMessage(channelId: string, messageId: string): Promise<void> {
    const slug = this.requireSlug();
    const parentId = this.messageMap[messageId]?.parent;
    await this.service.removeMessage(slug, channelId, messageId);
    if (parentId) {
      // A reply: it isn't in the channel's list, and its parent's summary changed.
      await Promise.all([this.refetchMessage(channelId, messageId), this.refetchMessage(channelId, parentId)]);
      return;
    }
    await this.fetchMessage(channelId, messageId);
  }

  /** Tie a work item just created from a message to it, and post the note saying so in the message's thread. */
  async linkWorkItem(channelId: string, messageId: string, issueId: string): Promise<void> {
    const slug = this.requireSlug();
    const commit = this.guard();
    const { message, reply } = await this.service.linkWorkItem(slug, channelId, messageId, issueId);
    commit(() => {
      if (message.parent) this.upsertReplies(message.parent, [message], "newer");
      else if (this.channelMessages[channelId]?.loaded) this.upsertMessages(channelId, [message], "newer");
      if (reply?.parent) this.upsertReplies(reply.parent, [reply], "newer");
    });
    // Linked from a reply: the note joined that reply's thread, so its parent's summary changed.
    if (reply?.parent && reply.parent !== message.id) await this.refetchMessage(channelId, reply.parent);
  }

  /** Move the read cursor to the newest loaded message, if it isn't there already. */
  async markRead(channelId: string): Promise<void> {
    return this.coalesce(this.readsInFlight, channelId, async () => {
      const slug = this.workspaceSlug;
      const channel = this.channelMap[channelId];
      const ids = this.channelMessages[channelId]?.ids ?? [];
      const newest = ids[ids.length - 1];
      if (!slug || !channel?.is_member || !newest) return;
      if (channel.last_read_message_id === newest && channel.unread_count === 0) return;
      // The cursor only moves forward on the server; don't send it backwards from a stale view either.
      const current = channel.last_read_message_id ? this.messageMap[channel.last_read_message_id] : undefined;
      const target = this.messageMap[newest];
      if (current && target && !isBefore(current, target) && channel.unread_count === 0) return;
      const commit = this.guard();
      commit(() => {
        channel.unread_count = 0;
        channel.last_read_message_id = newest;
      });
      try {
        const updated = await this.service.markRead(slug, channelId, newest);
        commit(() => this.upsertChannel(updated));
      } catch {
        // The next read (or resync) puts the count right.
        void this.refreshChannel(channelId);
      }
    });
  }

  // live updates

  private handleEvent(event: TChatEvent): void {
    const channelId = event.channel_id;
    if (!channelId) return;
    const known = !!this.channelMap[channelId];
    const aboutMe = event.user_id !== undefined && event.user_id === this.userId;

    switch (event.type) {
      case "message.created": {
        if (event.parent_id) {
          // A thread reply: the parent's summary changed, and an open thread shows it. It isn't counted as unread.
          if (this.messageMap[event.parent_id]) void this.refetchMessage(channelId, event.parent_id);
          if (event.message_id && this.threadMessages[event.parent_id] && !this.messageMap[event.message_id]) {
            void this.fetchReply(channelId, event.parent_id, event.message_id);
          }
          return;
        }
        const channel = this.channelMap[channelId];
        if (!channel) {
          void this.refreshChannel(channelId);
          return;
        }
        channel.last_message_at = event.at;
        const mine = event.actor_id !== undefined && event.actor_id === this.userId;
        const viewing = this.isViewing(channelId);
        if (channel.is_member && !mine && !viewing) channel.unread_count += 1;
        if (event.message_id && !this.messageMap[event.message_id]) {
          void this.receiveMessage(channelId, event.message_id, viewing);
        } else if (viewing) {
          void this.markRead(channelId);
        }
        return;
      }
      case "message.updated":
      case "message.removed": {
        if (event.message_id && this.messageMap[event.message_id])
          void this.refetchMessage(channelId, event.message_id);
        if (event.parent_id && this.messageMap[event.parent_id]) void this.refetchMessage(channelId, event.parent_id);
        // A removed message may have been counted as unread.
        if (event.type === "message.removed" && known && !event.parent_id) void this.refreshChannel(channelId);
        return;
      }
      case "channel.created":
      case "channel.updated":
      case "channel.archived":
      case "channel.unarchived":
        void this.refreshChannel(channelId);
        return;
      case "member.added":
      case "member.removed":
      case "member.updated":
        // My own: the channel appears, goes, or my role changed. Someone else's: the member count changed.
        if (aboutMe || known) void this.refreshChannel(channelId);
        return;
      case "read.updated":
        // Read in another tab.
        if (known) void this.refreshChannel(channelId);
        return;
      default:
        return;
    }
  }

  /** A new message: fetch it into the channel, then move the read cursor past it if the user is looking. */
  private async receiveMessage(channelId: string, messageId: string, viewing: boolean): Promise<void> {
    await this.fetchMessage(channelId, messageId);
    if (viewing) await this.markRead(channelId);
  }

  /**
   * Re-read a message the store already holds (an edit, a removal, a new reply). Calls while one is in flight collapse
   * into one more read: a new reply doesn't change its parent's `updated_at`, so an older answer landing last would
   * otherwise put back an older reply count.
   */
  private refetchMessage(channelId: string, messageId: string): Promise<void> {
    return this.coalesce(this.messageRefetches, messageId, async () => {
      const slug = this.workspaceSlug;
      if (!slug || !this.messageMap[messageId]) return;
      const commit = this.guard();
      try {
        const message = await this.service.getMessage(slug, channelId, messageId);
        commit(() => {
          if (this.messageMap[messageId]) this.holdMessage(message);
        });
      } catch {
        // The channel is gone or unreadable; its own events or the next resync say so.
      }
    });
  }

  /** After a reconnect or a `resync`: what may have happened while events weren't arriving. */
  private resync(): Promise<void> {
    // Live events can land before the catch-up reaches a channel, so note now where its unbroken history ends.
    this.noteCatchUpCursors();
    if (this.resyncing) {
      this.resyncing.again = true;
      return this.resyncing.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    const generation = this.generation;
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          // oxlint-disable-next-line no-await-in-loop -- a resync asked for during one runs once more after it
          await this.fetchChannels();
          if (generation !== this.generation) return;
          const loaded = Object.keys(this.channelMessages).filter((id) => this.channelMessages[id]?.loaded);
          const threads = Object.keys(this.threadMessages).filter((id) => this.threadMessages[id]?.loaded);
          // oxlint-disable-next-line no-await-in-loop -- see above
          await Promise.all([...loaded.map((id) => this.catchUp(id)), ...threads.map((id) => this.catchUpThread(id))]);
        } while (entry.again && generation === this.generation);
      } finally {
        if (this.resyncing === entry) this.resyncing = null;
      }
    })();
    this.resyncing = entry;
    return entry.promise;
  }

  /** Records where each loaded channel's and thread's unbroken history ends, unless an earlier gap already has. */
  private noteCatchUpCursors(): void {
    for (const [channelId, state] of Object.entries(this.channelMessages)) {
      const newest = state.ids[state.ids.length - 1];
      if (state.loaded && newest && !this.catchUpCursors.has(channelId)) this.catchUpCursors.set(channelId, newest);
    }
    for (const [parentId, state] of Object.entries(this.threadMessages)) {
      const newest = state.ids[state.ids.length - 1];
      if (state.loaded && newest && !this.threadCatchUpCursors.has(parentId)) {
        this.threadCatchUpCursors.set(parentId, newest);
      }
    }
  }

  private async catchUp(channelId: string): Promise<void> {
    const slug = this.workspaceSlug;
    if (!slug) return;
    const commit = this.guard();
    const generation = this.generation;
    try {
      let cursor = this.catchUpCursors.get(channelId);
      let pages = 0;
      let hasMore = true;
      while (cursor && hasMore && pages < MAX_CATCH_UP_PAGES) {
        // oxlint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's newest message
        const page: TChatMessagePage = await this.service.listMessages(slug, channelId, {
          after: cursor,
          limit: CHAT_PAGE_SIZE,
        });
        if (generation !== this.generation) return;
        pages += 1;
        hasMore = page.has_more;
        cursor = page.results.at(-1)?.id ?? cursor;
        const reached = cursor;
        commit(() => {
          this.upsertMessages(channelId, page.results, "newer");
          // If a later page fails, the next resync carries on from here.
          this.catchUpCursors.set(channelId, reached);
        });
      }
      if (!cursor || hasMore) {
        // Empty when events stopped (nothing to page from), or too far behind to page through: start over.
        await this.loadNewestMessages(channelId);
      } else {
        // `after` only brings new messages: re-read the newest page for edits and removals made meanwhile.
        const latest = await this.service.listMessages(slug, channelId, { limit: CHAT_PAGE_SIZE });
        commit(() => {
          this.upsertMessages(channelId, latest.results, "newer");
          this.catchUpCursors.delete(channelId);
        });
      }
      if (this.isViewing(channelId)) await this.markRead(channelId);
    } catch (error) {
      if (isNotFound(error)) commit(() => this.removeChannelLocally(channelId));
    }
  }

  /** Like `catchUp`, for the open thread, then re-read its first message, whose summary may have changed. */
  private async catchUpThread(parentId: string): Promise<void> {
    const slug = this.workspaceSlug;
    const channelId = this.threadMessages[parentId]?.channelId;
    if (!slug || !channelId) return;
    const commit = this.guard();
    const generation = this.generation;
    try {
      let cursor = this.threadCatchUpCursors.get(parentId);
      let pages = 0;
      let hasMore = true;
      while (cursor && hasMore && pages < MAX_CATCH_UP_PAGES) {
        // oxlint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's newest reply
        const page: TChatMessagePage = await this.service.listReplies(slug, channelId, parentId, {
          after: cursor,
          limit: CHAT_PAGE_SIZE,
        });
        if (generation !== this.generation || !this.isThreadOpen(parentId)) return;
        pages += 1;
        hasMore = page.has_more;
        cursor = page.results.at(-1)?.id ?? cursor;
        const reached = cursor;
        commit(() => {
          this.upsertReplies(parentId, page.results, "newer");
          this.threadCatchUpCursors.set(parentId, reached);
        });
      }
      if (!cursor || hasMore) {
        await this.loadNewestReplies(channelId, parentId);
      } else {
        const latest = await this.service.listReplies(slug, channelId, parentId, { limit: CHAT_PAGE_SIZE });
        commit(() => {
          this.upsertReplies(parentId, latest.results, "newer");
          this.threadCatchUpCursors.delete(parentId);
        });
      }
      await this.refetchMessage(channelId, parentId);
    } catch {
      // The channel's own catch-up finds out if it went; the thread is tried again on the next resync.
    }
  }
}
