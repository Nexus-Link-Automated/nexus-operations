/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type {
  TChatChannel,
  TChatChannelCreate,
  TChatChannelMember,
  TChatChannelUpdate,
  TChatMe,
  TChatMessage,
  TChatMessagePage,
  TChatMessagePageQuery,
  TChatMessageWrite,
  TChatWorkItemLink,
} from "@plane/types";
import { APIService } from "../api.service";

/** A chat request failed. `status` is the HTTP status, or 0 when the API was unreachable. */
export class ChatServiceError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    const detail = (data as { error?: unknown; detail?: unknown } | undefined) ?? {};
    const message =
      typeof detail.error === "string" ? detail.error : typeof detail.detail === "string" ? detail.detail : "";
    super(message || `Chat request failed (${status || "network error"})`);
    this.name = "ChatServiceError";
    this.status = status;
    this.data = data;
  }

  /** The channel or message is gone, or the caller can no longer see it (the API never says which). */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

function toChatError(error: unknown): ChatServiceError {
  const response = (error as { response?: { status?: number; data?: unknown } } | undefined)?.response;
  return new ChatServiceError(response?.status ?? 0, response?.data);
}

/**
 * Nexus Messages over REST (`/api/workspaces/<slug>/chat/`). Every write goes through here; the chat gateway's
 * socket only says that something changed.
 */
export class ChatService extends APIService {
  constructor(BASE_URL?: string) {
    super(BASE_URL || API_BASE_URL);
  }

  private base(workspaceSlug: string): string {
    return `/api/workspaces/${encodeURIComponent(workspaceSlug)}/chat`;
  }

  private channel(workspaceSlug: string, channelId: string): string {
    return `${this.base(workspaceSlug)}/channels/${encodeURIComponent(channelId)}`;
  }

  private async call<T>(request: Promise<{ data: T }>): Promise<T> {
    try {
      return (await request).data;
    } catch (error) {
      throw toChatError(error);
    }
  }

  /** The caller's role and chat abilities, and the workspace's ID. */
  async me(workspaceSlug: string): Promise<TChatMe> {
    return this.call(this.get(`${this.base(workspaceSlug)}/me/`));
  }

  /** Every channel and DM the caller can see, live or (with `archived`) archived. */
  async listChannels(workspaceSlug: string, archived = false): Promise<TChatChannel[]> {
    return this.call(this.get(`${this.base(workspaceSlug)}/channels/`, { params: { archived } }));
  }

  async getChannel(workspaceSlug: string, channelId: string): Promise<TChatChannel> {
    return this.call(this.get(`${this.channel(workspaceSlug, channelId)}/`));
  }

  async createChannel(workspaceSlug: string, data: TChatChannelCreate): Promise<TChatChannel> {
    return this.call(this.post(`${this.base(workspaceSlug)}/channels/`, data));
  }

  async updateChannel(workspaceSlug: string, channelId: string, data: TChatChannelUpdate): Promise<TChatChannel> {
    return this.call(this.patch(`${this.channel(workspaceSlug, channelId)}/`, data));
  }

  /** Open the DM (one other person) or group DM (several) with exactly these people, creating it if needed. */
  async openDm(workspaceSlug: string, memberIds: string[]): Promise<TChatChannel> {
    return this.call(this.post(`${this.base(workspaceSlug)}/dms/`, { member_ids: memberIds }));
  }

  async joinChannel(workspaceSlug: string, channelId: string): Promise<TChatChannel> {
    return this.call(this.post(`${this.channel(workspaceSlug, channelId)}/join/`, {}));
  }

  async leaveChannel(workspaceSlug: string, channelId: string): Promise<void> {
    await this.call(this.post(`${this.channel(workspaceSlug, channelId)}/leave/`, {}));
  }

  /** Move the caller's read cursor forward to this top-level message. */
  async markRead(workspaceSlug: string, channelId: string, messageId: string): Promise<TChatChannel> {
    return this.call(this.post(`${this.channel(workspaceSlug, channelId)}/read/`, { message_id: messageId }));
  }

  async listMembers(workspaceSlug: string, channelId: string): Promise<TChatChannelMember[]> {
    return this.call(this.get(`${this.channel(workspaceSlug, channelId)}/members/`));
  }

  async addMembers(workspaceSlug: string, channelId: string, memberIds: string[]): Promise<TChatChannelMember[]> {
    return this.call(this.post(`${this.channel(workspaceSlug, channelId)}/members/`, { member_ids: memberIds }));
  }

  /** A page of top-level messages, oldest to newest. */
  async listMessages(
    workspaceSlug: string,
    channelId: string,
    query: TChatMessagePageQuery = {}
  ): Promise<TChatMessagePage> {
    return this.call(this.get(`${this.channel(workspaceSlug, channelId)}/messages/`, { params: query }));
  }

  async getMessage(workspaceSlug: string, channelId: string, messageId: string): Promise<TChatMessage> {
    return this.call(this.get(`${this.channel(workspaceSlug, channelId)}/messages/${encodeURIComponent(messageId)}/`));
  }

  async sendMessage(workspaceSlug: string, channelId: string, data: TChatMessageWrite): Promise<TChatMessage> {
    return this.call(this.post(`${this.channel(workspaceSlug, channelId)}/messages/`, data));
  }

  async linkWorkItem(
    workspaceSlug: string,
    channelId: string,
    messageId: string,
    issueId: string
  ): Promise<TChatWorkItemLink> {
    return this.call(
      this.post(`${this.channel(workspaceSlug, channelId)}/messages/${messageId}/work-items/`, { issue_id: issueId })
    );
  }

  async editMessage(
    workspaceSlug: string,
    channelId: string,
    messageId: string,
    data: Pick<TChatMessageWrite, "body_html" | "body_json">
  ): Promise<TChatMessage> {
    return this.call(
      this.patch(`${this.channel(workspaceSlug, channelId)}/messages/${encodeURIComponent(messageId)}/`, data)
    );
  }

  /** Remove a message. It stays as a tombstone, so replies and read cursors keep working. */
  async removeMessage(workspaceSlug: string, channelId: string, messageId: string): Promise<void> {
    await this.call(
      this.delete(`${this.channel(workspaceSlug, channelId)}/messages/${encodeURIComponent(messageId)}/`)
    );
  }
}
