/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { z } from "zod";

/**
 * The events Django publishes to Redis (`plane/chat/events.py` is the other half of this contract).
 *
 * IDs only, never message bodies: the browser fetches what it needs over REST, where permissions are enforced.
 * Who sees an event is decided from what the API told the gateway, and from `member.*` events about the user
 * themselves, which Django publishes only after the change has committed.
 */
export const EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.removed",
  "channel.created",
  "channel.updated",
  "channel.archived",
  "channel.unarchived",
  "member.added",
  "member.removed",
  "member.updated",
  "read.updated",
  "access.revoked",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const id = z.string().min(1);

export const chatEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  workspace_id: id,
  /** Absent for `access.revoked`. */
  channel_id: id.optional(),
  /** `message.*`: the message. `read.updated`: the message the read cursor moved to. */
  message_id: id.optional(),
  /** `message.*` only, when the message is a thread reply. */
  parent_id: id.optional(),
  /** `member.*`, `read.updated` and `access.revoked`: the person it is about. */
  user_id: id.optional(),
  /** `member.*` about an agent from the registry instead of a person (never with `user_id`): the agent's ID. */
  agent_id: id.optional(),
  /** Who made the change; absent when nobody did through a request. */
  actor_id: id.optional(),
  /** When it was made (ISO 8601, UTC). */
  at: z.string(),
});

export type ChatEvent = z.infer<typeof chatEventSchema>;

/** Far more than an event of IDs can be; anything bigger is not one, and is not passed on to every socket. */
const MAX_EVENT_CHARS = 4 * 1024;

/** The event in a Redis message, or `undefined` if it isn't one (a type this gateway doesn't know, or garbage). */
export function parseEvent(raw: string): ChatEvent | undefined {
  if (raw.length > MAX_EVENT_CHARS) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = chatEventSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
