/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** The per-user rate limits on Nexus Messages requests, by what they limit. */
export type TInstanceChatRateLimitName = "send" | "edit" | "upload" | "channel" | "search" | "read" | "work_item";

/** God mode's Messages settings (`/api/instances/chat/settings/`). */
export type TInstanceChatSettings = {
  /** 0 keeps messages forever. */
  retention_days: number;
  min_retention_days: number;
  max_retention_days: number;
  /** How long an export can be downloaded. */
  export_expiry_hours: number;
  /** Read only: each is one or more DRF rates such as "30/minute", all of which apply. */
  rate_limits: Partial<Record<TInstanceChatRateLimitName, string[]>>;
};

export type TMessageExportStatus = "queued" | "running" | "ready" | "failed" | "expired";

/** One export of a workspace's messages, and the record of who started it. */
export type TMessageExport = {
  id: string;
  workspace_id: string | null;
  workspace_slug: string;
  workspace_name: string;
  requested_by_id: string | null;
  requested_by_email: string;
  /** Private channels and DMs as well as public channels. */
  include_private: boolean;
  status: TMessageExportStatus;
  size: number;
  channel_count: number;
  message_count: number;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
  can_download: boolean;
};

export type TMessageExportCreate = {
  workspace_id: string;
  include_private: boolean;
};
