/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { TBotMember, TBotMemberCreate, TBotMemberUpdate, TBotMemberWithToken } from "@plane/types";
import { APIService } from "../api.service";
import { toCodingError } from "./coding-job.service";

/**
 * A workspace's bot members (EmployAI agents), through the web app's session routes (the same paths as `/api/v1/`).
 * Workspace admins only; everyone else gets 403. Every failure is thrown as a `CodingJobServiceError`.
 */
export class BotMemberService extends APIService {
  constructor(BASE_URL?: string) {
    super(BASE_URL || API_BASE_URL);
  }

  private botsPath(workspaceSlug: string) {
    return `/api/workspaces/${workspaceSlug}/bot-members/`;
  }

  private botPath(workspaceSlug: string, botId: string) {
    return `${this.botsPath(workspaceSlug)}${botId}/`;
  }

  /** Every bot member of the workspace, removed ones included. */
  async list(workspaceSlug: string): Promise<TBotMember[]> {
    return this.get(this.botsPath(workspaceSlug))
      .then((response) => (response?.data as TBotMember[]) ?? [])
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Creates a bot member. The answer carries its token, which is never shown again. */
  async create(workspaceSlug: string, data: TBotMemberCreate): Promise<TBotMemberWithToken> {
    return this.post(this.botsPath(workspaceSlug), data)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Changes only the fields sent. */
  async update(workspaceSlug: string, botId: string, data: TBotMemberUpdate): Promise<TBotMember> {
    return this.patch(this.botPath(workspaceSlug, botId), data)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Removes the bot from the workspace and its projects; its token stops working. */
  async remove(workspaceSlug: string, botId: string): Promise<void> {
    return this.delete(this.botPath(workspaceSlug, botId))
      .then(() => undefined)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Gives the bot a new token (shown once); its earlier tokens stop working. */
  async rotateToken(workspaceSlug: string, botId: string): Promise<TBotMemberWithToken> {
    return this.post(`${this.botPath(workspaceSlug, botId)}token/`, {})
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }
}
