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

import type { TAgentAdapter, TAgentPermissionLevel } from "./agent";
import type { TFileSignedURLResponse } from "./file";
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
  /** The linked project, whose work items' state changes are posted here. Never set on DMs and group DMs. */
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

/** A file on a message. Both URLs are API paths: the API checks channel membership, then redirects to storage. */
export type TChatAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Set only for raster images the API will show inline. Anything else (SVG included) only downloads. */
  preview_url: string | null;
  download_url: string;
};

/** A file uploaded but not yet on a message, enough to send it and to show it while it's sending. */
export type TChatUploadedAttachment = Pick<TChatAttachment, "id" | "name" | "type" | "size">;

/** A presigned POST for one file (`attachments/`). */
export type TChatAttachmentUploadSlot = Pick<TFileSignedURLResponse, "asset_id" | "upload_data">;

/** What linking a work item to a message returns; `reply` is null if it was already linked. */
export type TChatWorkItemLink = {
  message: TChatMessage;
  reply: TChatMessage | null;
};

/** What an automatic message announces. */
export type TChatSystemEvent = "work_item_state";

/** An agent from the registry, as a message from it shows it. */
export type TChatAgentDetails = {
  id: string;
  slug: string;
  name: string;
  adapter: TAgentAdapter;
  /** Disabled in the registry for now. */
  is_available: boolean;
};

/** Why an agent's message is a note instead of an answer to a mention. */
export type TChatAgentNotice =
  | "timeout"
  | "unavailable"
  | "credentials"
  | "failed"
  | "empty"
  | "rate_limited"
  | "still_working";

/**
 * A message, or a removed message's tombstone (empty body, `removed_at` set). Exactly one of `sender`,
 * `sender_agent` and `system_event` is set; an automatic message (`system_event`) has no sender and can't be edited.
 */
export type TChatMessage = {
  id: string;
  workspace: string;
  channel: string;
  sender: string | null;
  /** The agent's slug, for a message an agent sent. */
  sender_agent: string | null;
  /** That agent as the registry has it now; null once it is deleted from the registry (show "Removed agent"). */
  sender_agent_details: TChatAgentDetails | null;
  system_event: TChatSystemEvent | null;
  /**
   * Set on an agent's message that is a note instead of an answer to a mention: why it couldn't answer. The body
   * says so too, in English; show the note in the reader's language instead.
   */
  agent_notice: TChatAgentNotice | null;
  body_html: string;
  body_json: Record<string, unknown>;
  body_stripped: string;
  /** The thread's first message, for a reply. */
  parent: string | null;
  reply_count: number;
  last_reply_at: string | null;
  references: TChatMessageReference[];
  /** Its files, for a channel member. Someone reading a channel they're not in gets none, and `attachment_count`. */
  attachments: TChatAttachment[];
  attachment_count: number;
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

/** Search terms and filters (`search/`). `q` is 2 to 200 characters; its last word also matches as a prefix. */
export type TChatSearchQuery = {
  q: string;
  /** Only this channel or DM. */
  channel?: string;
  /** Only this person's messages, which leaves out automatic and agent messages. */
  sender?: string;
  /** ISO 8601: from this moment on. */
  since?: string;
  /** ISO 8601: before this moment. */
  until?: string;
  /** `false` leaves out automatic messages. */
  automatic?: boolean;
  /** A result's message ID: the results just older than it. */
  before?: string;
  limit?: number;
};

/** Part of a result's snippet: plain text, to render as text, with `match` set on the words that matched. */
export type TChatSearchSnippetSegment = { text: string; match: boolean };

/** A result's channel, enough to name it and link to it. It may be archived, which the channel list leaves out. */
export type TChatSearchChannel = Pick<
  TChatChannel,
  "id" | "kind" | "name" | "archived_at" | "is_member" | "dm_member_ids"
>;

export type TChatSearchResult = {
  message: TChatMessage;
  channel: TChatSearchChannel;
  snippet: TChatSearchSnippetSegment[];
};

/** One page of results, newest first. `has_more`: there are older ones. */
export type TChatSearchPage = {
  results: TChatSearchResult[];
  has_more: boolean;
};

export type TChatMessageWrite = {
  body_html: string;
  body_json?: Record<string, unknown>;
  parent_id?: string | null;
  /** Finished uploads by the sender for this channel. A message with some doesn't need any text. */
  attachment_ids?: string[];
};

/** An edit replaces both bodies: the API stores an empty `body_json` if it is left out. */
export type TChatMessageEdit = {
  body_html: string;
  body_json: Record<string, unknown>;
};

export type TChatChannelCreate = {
  name: string;
  description?: string;
  kind?: "public" | "private";
  /** A project the caller is a member or admin of. */
  project?: string | null;
};

export type TChatChannelUpdate = {
  name?: string;
  description?: string;
  /** Linking needs membership of the project; `null` unlinks. */
  project?: string | null;
};

/** What the caller may do in this workspace's chat (`chat/me/`). */
export type TChatMe = {
  workspace_id: string;
  workspace_role: number;
  is_workspace_admin: boolean;
  can_create_channels: boolean;
  can_open_dms: boolean;
  /** Admins and members, in a channel they administer (any channel, for a workspace admin). Never guests. */
  can_add_agents: boolean;
  /** Admins and members: an @mention of an agent in a channel they are in asks it to reply. Never guests. */
  can_mention_agents: boolean;
  /** How long an agent may work on a mention before it stops. */
  agent_reply_timeout_seconds: number;
};

export type TChatChannelMember = {
  id: string;
  channel: string;
  user: string;
  role: TChatMemberRole;
  created_at: string;
};

/** A guest's chat grants in one workspace (`chat/guests/dm-access/`). */
export type TChatGuestPermission = {
  id: string;
  workspace: string;
  user: string;
  can_open_dms: boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

/**
 * An agent from the registry that is a member of a public or private channel (`agents/`). DMs never have agents. In a
 * private channel an agent can read what is said there.
 */
export type TChatChannelAgent = {
  id: string;
  channel: string;
  /** The agent's registry ID. */
  agent: string;
  slug: string;
  name: string;
  description: string;
  adapter: TAgentAdapter;
  /** The level it works at here: as chosen when it was added, at most the registry's maximum. */
  permission_level: TAgentPermissionLevel;
  /** False while the registry has it disabled: listed, but nothing reaches it. */
  is_available: boolean;
  added_by: string | null;
  added_at: string;
};

/** Adding an agent: its registry ID, and a level up to its maximum (its default if left out). */
export type TChatChannelAgentAdd = {
  agent_id: string;
  permission_level?: TAgentPermissionLevel;
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
  | "access.revoked"
  | "agent.responding"
  | "agent.responded";

/** A chat event: IDs only. Fetch what it is about over REST. */
export type TChatEvent = {
  type: TChatEventType;
  workspace_id: string;
  channel_id?: string;
  /** `message.*`: the message. `agent.*`: the message that mentioned the agent. */
  message_id?: string;
  /** `message.*` on a thread reply: the thread's first message. `agent.*`: the thread the agent replies in. */
  parent_id?: string;
  /** `member.*`, `read.updated`: the person it is about. */
  user_id?: string;
  /** `member.*` about an agent instead of a person, and `agent.*`: the agent's registry ID. */
  agent_id?: string;
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
