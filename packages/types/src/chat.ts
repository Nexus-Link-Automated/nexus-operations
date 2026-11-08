/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * Nexus Messages: what the chat REST API (`/api/workspaces/<slug>/chat/`, `apps/api/plane/chat`) and the chat
 * gateway's socket (`/chat/ws`, `apps/chat-gateway`) send. Their serializers and `protocol.ts` are the source of
 * truth; these types follow them.
 */

import type { TIssuePriorities } from "./issues";
import type { TStateGroups } from "./state";

export type TChatChannelKind = "public" | "private" | "dm" | "group_dm";

export type TChatMemberRole = "admin" | "member";

/** A channel or DM as the signed-in user sees it. */
export type TChatChannel = {
  id: string;
  workspace: string;
  kind: TChatChannelKind;
  /** Empty for DMs and group DMs: name them from `dm_member_ids`. */
  name: string;
  description: string;
  project: string | null;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_member: boolean;
  my_role: TChatMemberRole | null;
  last_read_message_id: string | null;
  /** Top-level messages after my read cursor that are not removed and not mine; 0 if I'm not a member. */
  unread_count: number;
  last_message_at: string | null;
  member_count: number;
  /** Everyone in a DM or group DM, the caller included; empty for named channels. */
  dm_member_ids: string[];
};

/** A message, or a removed message's tombstone (empty body, `removed_at` set). */
/** A work item a message references, present only if the reader may see it. */
export type TChatMessageReference = {
  id: string;
  project: string;
  /** e.g. `EMP-142`. */
  key: string;
  name: string;
  priority: TIssuePriorities;
  state: { name: string; group: TStateGroups; color: string } | null;
};

/** What linking a work item to a message returns; `reply` is null if it was already linked. */
export type TChatWorkItemLink = {
  message: TChatMessage;
  reply: TChatMessage | null;
};

export type TChatMessage = {
  id: string;
  workspace: string;
  channel: string;
  sender: string | null;
  sender_agent: string | null;
  body_html: string;
  body_json: Record<string, unknown>;
  body_stripped: string;
  /** The thread's first message, for a reply. */
  parent: string | null;
  reply_count: number;
  last_reply_at: string | null;
  references: TChatMessageReference[];
  edited_at: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** One page of messages, oldest to newest. `has_more`: more in the direction asked for. */
export type TChatMessagePage = {
  results: TChatMessage[];
  has_more: boolean;
};

export type TChatMessagePageQuery = {
  /** A message ID: the page just older than it. */
  before?: string;
  /** A message ID: the page just newer than it. */
  after?: string;
  limit?: number;
};

export type TChatMessageWrite = {
  body_html: string;
  body_json?: Record<string, unknown>;
  parent_id?: string | null;
};

export type TChatChannelCreate = {
  name: string;
  description?: string;
  kind?: "public" | "private";
};

export type TChatChannelUpdate = {
  name?: string;
  description?: string;
};

/** What the caller may do in this workspace's chat (`chat/me/`). */
export type TChatMe = {
  workspace_id: string;
  workspace_role: number;
  is_workspace_admin: boolean;
  can_create_channels: boolean;
  can_open_dms: boolean;
};

export type TChatChannelMember = {
  id: string;
  channel: string;
  user: string;
  role: TChatMemberRole;
  created_at: string;
};

export type TChatEventType =
  | "message.created"
  | "message.updated"
  | "message.removed"
  | "channel.created"
  | "channel.updated"
  | "channel.archived"
  | "channel.unarchived"
  | "member.added"
  | "member.removed"
  | "member.updated"
  | "read.updated"
  | "access.revoked";

/** A chat event: IDs only. Fetch what it is about over REST. */
export type TChatEvent = {
  type: TChatEventType;
  workspace_id: string;
  channel_id?: string;
  message_id?: string;
  /** `message.*` on a thread reply: the thread's first message. */
  parent_id?: string;
  /** `member.*`, `read.updated`: the person it is about. */
  user_id?: string;
  /** Who made the change, when someone did. */
  actor_id?: string;
  at: string;
};

export type TChatSocketErrorCode = "bad_request" | "not_found" | "too_many_subscriptions" | "unavailable";

/** A frame from the chat gateway. */
export type TChatServerFrame =
  | { type: "ready"; user_id: string; workspace_id: string; channels: string[] }
  | { type: "pong" }
  | { type: "event"; event: TChatEvent }
  | { type: "subscribed"; channel_id: string }
  | { type: "unsubscribed"; channel_id: string; reason: "requested" | "access_lost" }
  | { type: "resync"; reason: "events_missed" | "membership_changed" }
  | { type: "error"; code: TChatSocketErrorCode; message: string; channel_id?: string };

/** A frame to the chat gateway. */
export type TChatClientFrame =
  | { type: "ping" }
  | { type: "subscribe"; channel_id: string }
  | { type: "unsubscribe"; channel_id: string };
