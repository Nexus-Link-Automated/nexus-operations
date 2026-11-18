/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { fakeBotService, makeBot } from "@/components/bot-members/test-utils";
import { BotMemberStore } from "./bot-member.store";

describe("BotMemberStore", () => {
  it("creates a bot and gives a new token without keeping either token", async () => {
    const service = fakeBotService({
      list: vi.fn().mockResolvedValue([makeBot("b1")]),
      create: vi.fn().mockResolvedValue({ ...makeBot("b2"), token: "plane_api_one" }),
      rotateToken: vi
        .fn()
        .mockResolvedValue({ ...makeBot("b1", { token_created_at: "2026-11-15T00:00:00Z" }), token: "plane_api_two" }),
    });
    const store = new BotMemberStore({ service });
    await store.fetchBots("acme");

    expect((await store.createBot("acme", { name: "Bot b2" })).token).toBe("plane_api_one");
    expect((await store.rotateToken("acme", "b1")).token).toBe("plane_api_two");

    expect(store.getBots("acme")?.map((bot) => bot.id)).toEqual(["b1", "b2"]);
    expect(store.getBots("acme")?.some((bot) => "token" in bot)).toBe(false);
    expect(store.getBots("acme")?.[0].token_created_at).toBe("2026-11-15T00:00:00Z");
  });

  it("updates a bot in place and keeps a removed one listed as removed", async () => {
    const service = fakeBotService({
      list: vi.fn().mockResolvedValue([makeBot("b1"), makeBot("b2")]),
      update: vi.fn().mockResolvedValue(makeBot("b1", { role: 5 })),
    });
    const store = new BotMemberStore({ service });
    await store.fetchBots("acme");

    await store.updateBot("acme", "b1", { role: 5 });
    await store.removeBot("acme", "b2");

    expect(service.update).toHaveBeenCalledWith("acme", "b1", { role: 5 });
    expect(service.remove).toHaveBeenCalledWith("acme", "b2");
    expect(store.getBots("acme")?.map((bot) => [bot.id, bot.role, bot.is_active])).toEqual([
      ["b1", 5, true],
      ["b2", 15, false],
    ]);
  });

  it("drops a list that was requested before a change", async () => {
    let answer: ((bots: ReturnType<typeof makeBot>[]) => void) | undefined;
    const service = fakeBotService({
      list: vi
        .fn()
        .mockResolvedValueOnce([makeBot("b1")])
        .mockReturnValueOnce(new Promise((resolve) => (answer = resolve))),
      update: vi.fn().mockResolvedValue(makeBot("b1", { name: "Renamed" })),
    });
    const store = new BotMemberStore({ service });
    await store.fetchBots("acme");

    const stale = store.fetchBots("acme");
    await store.updateBot("acme", "b1", { name: "Renamed" });
    answer?.([makeBot("b1")]);
    await stale;

    expect(store.getBots("acme")?.[0].name).toBe("Renamed");
  });
});
