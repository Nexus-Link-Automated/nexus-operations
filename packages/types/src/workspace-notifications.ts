/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TAgentAdapter } from "./agent";
import type { ENotificationFilterType } from "./enums";
import type { IUserLite } from "./users";

// filters
export type TNotificationFilter = {
  type: {
    [key in ENotificationFilterType]: boolean;
  };
  snoozed: boolean;
  archived: boolean;
  read: boolean;
};

// notification payload
export type TNotificationIssueLite = {
  id: string | undefined;
  sequence_id: number | undefined;
  identifier: string | undefined;
  name: string | undefined;
  state_name: string | undefined;
  state_group: string | undefined;
};

/** What an inbox entry for a chat @mention carries. A snapshot; the server hides it once access is lost. */
export type TNotificationChatMessage = {
  id: string;
  channel_id: string;
  channel_name: string | null;
  channel_kind: "public" | "private" | "dm" | "group_dm";
  parent_id: string | null;
  preview: string;
  /**
   * The agent that sent it, as the registry had it when the entry was made; null for a person, absent on older
   * entries. `name` and `adapter` are null when the registry no longer had the agent: show "Removed agent".
   */
  sender_agent?: { slug: string; name: string | null; adapter: TAgentAdapter | null } | null;
};

export type TNotificationData = {
  issue?: TNotificationIssueLite;
  chat_message?: TNotificationChatMessage;
  issue_activity?: {
    id: string | undefined;
    actor: string | undefined;
    field: string | undefined;
    issue_comment: string | undefined;
    verb: "created" | "updated" | "deleted";
    new_value: string | undefined;
    old_value: string | undefined;
  };
};

export type TNotification = {
  id: string;
  title: string | undefined;
  data: TNotificationData | undefined;
  entity_identifier: string | undefined;
  entity_name: string | undefined;
  message_html: string | undefined;
  message: undefined;
  message_stripped: undefined;
  sender: string | undefined;
  receiver: string | undefined;
  triggered_by: string | undefined;
  triggered_by_details: IUserLite | undefined;
  read_at: string | undefined;
  archived_at: string | undefined;
  snoozed_till: string | undefined;
  is_inbox_issue: boolean | undefined;
  is_mentioned_notification: boolean | undefined;
  workspace: string | undefined;
  project: string | undefined;
  created_at: string | undefined;
  updated_at: string | undefined;
  created_by: string | undefined;
  updated_by: string | undefined;
};

// notification paginated information
export type TNotificationPaginatedInfoQueryParams = {
  type?: string | undefined;
  snoozed?: boolean;
  archived?: boolean;
  mentioned?: boolean;
  read?: boolean;
  per_page?: number;
  cursor?: string;
};

export type TNotificationPaginatedInfo = {
  next_cursor: string | undefined;
  prev_cursor: string | undefined;
  next_page_results: boolean | undefined;
  prev_page_results: boolean | undefined;
  total_pages: number | undefined;
  extra_stats: string | undefined;
  count: number | undefined; // current paginated results count
  total_count: number | undefined; // total available results count
  results: TNotification[] | undefined;
  grouped_by: string | undefined;
  sub_grouped_by: string | undefined;
};

// notification count
export type TUnreadNotificationsCount = {
  total_unread_notifications_count: number;
  mention_unread_notifications_count: number;
};

export type TNotificationLite = {
  workspace_slug: string | undefined;
  project_id: string | undefined;
  notification_id: string | undefined;
  issue_id: string | undefined;
  is_inbox_issue: boolean | undefined;
};
