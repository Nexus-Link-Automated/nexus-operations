/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ChatServiceError } from "@plane/services";
import type { TChatChannel, TChatMessage } from "@plane/types";

/** Messages by one sender closer together than this are shown as one block, under one name. */
const MESSAGE_GROUP_WINDOW_MS = 5 * 60_000;

/** How many people a group DM can hold, the caller included (`GROUP_DM_MAX_MEMBERS` in Django). */
export const GROUP_DM_MAX_MEMBERS = 9;

export type TMessageRow =
  | { kind: "day"; key: string; day: string }
  | { kind: "message"; key: string; message: TChatMessage; continued: boolean };

/** The local calendar day of an ISO timestamp, as `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whether two messages have the same sender: the same person, or both automatic posts of the same kind. */
function sameSender(a: TChatMessage, b: TChatMessage): boolean {
  if (a.sender || b.sender) return !!a.sender && a.sender === b.sender;
  return !!a.system_event && a.system_event === b.system_event;
}

/**
 * Rows for the message list: a divider at each new day, and each message marked `continued` when it follows the
 * same sender's previous message on that day within `MESSAGE_GROUP_WINDOW_MS` (so the name and avatar show once).
 * Removed messages never continue a block or start one others continue.
 */
export function buildMessageRows(messages: readonly TChatMessage[]): TMessageRow[] {
  const rows: TMessageRow[] = [];
  let previous: TChatMessage | undefined;
  let previousDay: string | undefined;
  for (const message of messages) {
    const day = localDay(message.created_at);
    if (day !== previousDay) {
      rows.push({ kind: "day", key: `day-${day}`, day });
      previous = undefined;
    }
    const continued =
      !!previous &&
      !previous.removed_at &&
      !message.removed_at &&
      sameSender(previous, message) &&
      Date.parse(message.created_at) - Date.parse(previous.created_at) < MESSAGE_GROUP_WINDOW_MS;
    rows.push({ kind: "message", key: message.id, message, continued });
    previous = message;
    previousDay = day;
  }
  return rows;
}

/** The other people in a DM or group DM. */
export function otherMemberIds(channel: Pick<TChatChannel, "dm_member_ids">, currentUserId: string | null): string[] {
  return channel.dm_member_ids.filter((id) => id !== currentUserId);
}

/**
 * What to call a channel: its name, or for a DM the other people's names. `getName` returns undefined for someone
 * the member store doesn't know (yet), who is shown as `unknown`.
 */
export function channelDisplayName(
  channel: Pick<TChatChannel, "kind" | "name" | "dm_member_ids">,
  currentUserId: string | null,
  getName: (userId: string) => string | undefined,
  unknown: string
): string {
  if (channel.kind !== "dm" && channel.kind !== "group_dm") return channel.name;
  const names = otherMemberIds(channel, currentUserId).map((id) => getName(id) || unknown);
  return names.length ? names.join(", ") : unknown;
}

export function unreadLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** The API refused the request for now because too many like it came from this person (429). */
export function isChatRateLimited(error: unknown): boolean {
  return error instanceof ChatServiceError && error.isRateLimited;
}

/** The API's own message for a failed request (a field error or `error`), if it gave one. */
export function chatErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof ChatServiceError)) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object") return undefined;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

/**
 * A link to a message in its channel. A thread reply links to its thread's first message, the one the channel shows,
 * and opens the thread on the reply.
 */
export function chatMessagePermalink(
  workspaceSlug: string,
  message: { id: string; channel_id: string; parent_id: string | null }
): string {
  const base = `/${workspaceSlug}/messages/${message.channel_id}`;
  return message.parent_id
    ? `${base}?message=${message.parent_id}&reply=${message.id}`
    : `${base}?message=${message.id}`;
}

const WORK_ITEM_TITLE_MAX = 255;

/** The first line of a message, as a work item title. */
export function workItemTitleFromMessage(bodyStripped: string): string {
  const firstLine = bodyStripped.trim().split(/\r?\n/)[0] ?? "";
  return firstLine.trim().slice(0, WORK_ITEM_TITLE_MAX);
}

/** The people @mentioned in a message's HTML, first mentioned first. */
export function mentionedUserIds(html: string): string[] {
  const ids = Array.from(
    new DOMParser()
      .parseFromString(html, "text/html")
      .querySelectorAll('mention-component[entity_name="user_mention"]'),
    (mention) => mention.getAttribute("entity_identifier")
  ).filter((id): id is string => !!id);
  return [...new Set(ids)];
}

/** Who a work item from a message starts assigned to: the first person mentioned who is in the project, else the clicker. */
export function defaultWorkItemAssignee(
  mentioned: string[],
  projectMemberIds: string[],
  clickerId: string | null
): string | null {
  const firstMentioned = mentioned.find((id) => projectMemberIds.includes(id));
  if (firstMentioned) return firstMentioned;
  return clickerId && projectMemberIds.includes(clickerId) ? clickerId : null;
}

/** The project a work item from a message starts in: the channel's, the one last used, or the user's first. */
export function defaultWorkItemProject(
  channelProject: string | null | undefined,
  lastUsedProject: string | null,
  joinedProjectIds: string[]
): string | undefined {
  if (channelProject && joinedProjectIds.includes(channelProject)) return channelProject;
  if (lastUsedProject && joinedProjectIds.includes(lastUsedProject)) return lastUsedProject;
  return joinedProjectIds[0];
}

const lastProjectKey = (workspaceSlug: string) => `chat-work-item-project:${workspaceSlug}`;

/** localStorage can be blocked or full; forgetting the last project only costs a click. */
export function readLastWorkItemProject(workspaceSlug: string): string | null {
  try {
    return localStorage.getItem(lastProjectKey(workspaceSlug));
  } catch {
    return null;
  }
}

export function writeLastWorkItemProject(workspaceSlug: string, projectId: string): void {
  try {
    localStorage.setItem(lastProjectKey(workspaceSlug), projectId);
  } catch {
    // see readLastWorkItemProject
  }
}
