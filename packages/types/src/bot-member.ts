/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** EmployAI agents as bot members of a workspace (`plane.coding.bot_members` in the API). */

/** A bot member is a member (15) or a guest (5), never an admin. */
export type TBotMemberRole = 15 | 5;

export type TBotMember = {
  /** The bot's user id: its member id in the workspace's members list. */
  id: string;
  name: string;
  display_name: string;
  description: string;
  /** Its workspace role; null once it was removed. */
  role: TBotMemberRole | number | null;
  /** Still a member of the workspace. */
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  token_created_at: string | null;
  token_last_used: string | null;
};

/** A bot member just created, or given a new token: the token is in it once and never again. */
export type TBotMemberWithToken = TBotMember & { token: string };

export type TBotMemberCreate = { name: string; role?: TBotMemberRole; description?: string };

export type TBotMemberUpdate = Partial<{ name: string; role: TBotMemberRole; description: string }>;

/** The codes the bot member endpoints refuse with (`{"error", "code"}`). */
export type TBotMemberErrorCode = "BOT_LIMIT" | "BOT_ROLE_NOT_ALLOWED" | "BOT_REMOVED";
