/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Mock } from "vitest";
import { vi } from "vitest";
import type { TBotMember } from "@plane/types";
import type { TBotMemberStoreService } from "@/store/bot-member.store";

/** Test data and fakes shared by the bot member tests. */

export const makeBot = (id: string, overrides: Partial<TBotMember> = {}): TBotMember => ({
  id,
  name: `Bot ${id}`,
  display_name: `bot-${id}-bot-ab12`,
  description: "",
  role: 15,
  is_active: true,
  created_by: "admin",
  created_at: "2026-11-14T09:00:00Z",
  token_created_at: "2026-11-14T09:00:00Z",
  token_last_used: null,
  ...overrides,
});

/** The fake service: every method a `vi.fn()` the test can inspect or re-program. */
export type TFakeBotService = { [K in keyof TBotMemberStoreService]: Mock<TBotMemberStoreService[K]> };

export const fakeBotService = (overrides: Partial<TBotMemberStoreService> = {}): TFakeBotService =>
  ({
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    rotateToken: vi.fn(),
    ...overrides,
  }) as TFakeBotService;
