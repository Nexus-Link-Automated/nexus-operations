/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TBotMember, TBotMemberRole } from "@plane/types";

/** The workspace roles a bot member can have: member (the default) or guest, never admin. */
export const BOT_MEMBER_ROLE = 15 satisfies TBotMemberRole;
export const BOT_GUEST_ROLE = 5 satisfies TBotMemberRole;

export const BOT_ROLES: TBotMemberRole[] = [BOT_MEMBER_ROLE, BOT_GUEST_ROLE];

/** The translation key of a bot's role, or null when it has none the page knows (such as after removal). */
export const botRoleKey = (role: TBotMember["role"]): string | null => {
  if (role === BOT_MEMBER_ROLE) return "bot_members.role.member";
  if (role === BOT_GUEST_ROLE) return "bot_members.role.guest";
  return null;
};
