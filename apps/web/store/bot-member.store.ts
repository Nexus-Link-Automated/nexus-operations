/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, runInAction } from "mobx";
import { BotMemberService } from "@plane/services";
import type { TBotMember, TBotMemberCreate, TBotMemberUpdate, TBotMemberWithToken } from "@plane/types";

/** The REST calls the store makes. `BotMemberService` in the app; a fake in tests. */
export type TBotMemberStoreService = Pick<BotMemberService, "list" | "create" | "update" | "remove" | "rotateToken">;

/** The bot as stored: its token is shown once by whoever asked for it, never kept. */
const withoutToken = (bot: TBotMemberWithToken): TBotMember => {
  const stored: Partial<TBotMemberWithToken> = { ...bot };
  delete stored.token;
  return stored as TBotMember;
};

/** A new list with `bot` in place of its old copy, or added at the end. */
const upsert = (bots: TBotMember[], bot: TBotMember) =>
  bots.some((existing) => existing.id === bot.id)
    ? bots.map((existing) => (existing.id === bot.id ? bot : existing))
    : [...bots, bot];

export interface IBotMemberStore {
  /** Workspace slug → its bot members (removed ones included), once loaded. */
  botsMap: Record<string, TBotMember[]>;
  getBots: (workspaceSlug: string | null | undefined) => TBotMember[] | undefined;
  /** Loads the workspace's bot members. Workspace admins only. */
  fetchBots: (workspaceSlug: string) => Promise<TBotMember[]>;
  /** Creates a bot member; the answer carries its token, which the store does not keep. */
  createBot: (workspaceSlug: string, data: TBotMemberCreate) => Promise<TBotMemberWithToken>;
  updateBot: (workspaceSlug: string, botId: string, data: TBotMemberUpdate) => Promise<TBotMember>;
  /** Gives the bot a new token (the answer carries it); its earlier tokens stop working. */
  rotateToken: (workspaceSlug: string, botId: string) => Promise<TBotMemberWithToken>;
  /** Removes the bot from the workspace; it stays listed as removed. */
  removeBot: (workspaceSlug: string, botId: string) => Promise<void>;
}

/**
 * A workspace's bot members (EmployAI agents), for workspace admins. Every action throws the API's refusal as a
 * `CodingJobServiceError` for the caller to show.
 */
export class BotMemberStore implements IBotMemberStore {
  botsMap: Record<string, TBotMember[]> = {};

  private service: TBotMemberStoreService;
  // Bumped by every change, so a list requested before it is dropped rather than bringing back what was changed.
  private version: Record<string, number> = {};
  private requests: Record<string, number> = {};

  constructor(options: { service?: TBotMemberStoreService } = {}) {
    makeObservable<BotMemberStore, "apply">(this, {
      botsMap: observable,
      fetchBots: action,
      createBot: action,
      updateBot: action,
      rotateToken: action,
      removeBot: action,
      apply: action,
    });
    this.service = options.service ?? new BotMemberService();
  }

  getBots = (workspaceSlug: string | null | undefined) => (workspaceSlug ? this.botsMap[workspaceSlug] : undefined);

  fetchBots = async (workspaceSlug: string) => {
    const version = this.version[workspaceSlug] ?? 0;
    const requestId = (this.requests[workspaceSlug] ?? 0) + 1;
    this.requests[workspaceSlug] = requestId;
    const bots = await this.service.list(workspaceSlug);
    const current = this.botsMap[workspaceSlug];
    if (this.requests[workspaceSlug] !== requestId || ((this.version[workspaceSlug] ?? 0) !== version && current)) {
      return current ?? bots;
    }
    runInAction(() => {
      this.botsMap[workspaceSlug] = bots;
    });
    return bots;
  };

  createBot = async (workspaceSlug: string, data: TBotMemberCreate) => {
    const created = await this.service.create(workspaceSlug, data);
    this.apply(workspaceSlug, withoutToken(created));
    return created;
  };

  updateBot = async (workspaceSlug: string, botId: string, data: TBotMemberUpdate) => {
    const bot = await this.service.update(workspaceSlug, botId, data);
    this.apply(workspaceSlug, bot);
    return bot;
  };

  rotateToken = async (workspaceSlug: string, botId: string) => {
    const bot = await this.service.rotateToken(workspaceSlug, botId);
    this.apply(workspaceSlug, withoutToken(bot));
    return bot;
  };

  removeBot = async (workspaceSlug: string, botId: string) => {
    await this.service.remove(workspaceSlug, botId);
    const bot = this.botsMap[workspaceSlug]?.find((existing) => existing.id === botId);
    // The API keeps a removed bot in its list, without its token.
    if (bot) this.apply(workspaceSlug, { ...bot, is_active: false, token_created_at: null, token_last_used: null });
  };

  private apply(workspaceSlug: string, bot: TBotMember) {
    this.version[workspaceSlug] = (this.version[workspaceSlug] ?? 0) + 1;
    const bots = this.botsMap[workspaceSlug];
    if (bots) this.botsMap[workspaceSlug] = upsert(bots, bot);
  }
}
