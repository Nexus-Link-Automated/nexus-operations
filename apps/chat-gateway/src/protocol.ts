/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { z } from "zod";

import type { ChatEvent } from "./events.ts";

/**
 * What the gateway and a browser say to each other: JSON text frames, each an object with a `type`.
 *
 * The socket only ever carries events out. Sending, editing and everything else goes through the REST API.
 *
 * Browser → gateway:
 *   ping
 *   subscribe    {channel_id}   to also follow a public channel the user has not joined
 *   unsubscribe  {channel_id}   (channels the user is a member of are always followed)
 *
 * Gateway → browser:
 *   ready         {user_id, workspace_id, channels}  admitted; `channels` are the ones the user is in, followed
 *                                                    from now on without asking. Wait for it before anything else.
 *   event         {event}                            a chat event for a channel the user may see. A channel
 *                                                    starts to follow when the user is added to it, so the first
 *                                                    thing they hear of it is their own `member.added`: fetch the
 *                                                    channel over REST then.
 *   subscribed    {channel_id}
 *   unsubscribed  {channel_id, reason}               "requested", or "access_lost" when the channel is no longer visible
 *   resync        {reason}                           events may have been missed ("events_missed") or the user's
 *                                                    channels changed without an event ("membership_changed"):
 *                                                    refetch the channel list and each open channel's messages
 *                                                    (`messages/?after=<last id>`)
 *   pong
 *   error         {code, message, channel_id?}
 */

/** Application close codes the browser sees (RFC 6455 reserves 4000-4999 for applications). */
export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  internalError: 1011,
  /** The socket couldn't keep up; reconnect and resync. */
  tryAgainLater: 1013,
  /** The URL or a frame is wrong; reconnecting as-is will fail again. */
  badRequest: 4400,
  /** No cookie, or the API does not accept it: sign in again. */
  unauthenticated: 4401,
  /** Signed in, but not a member of this workspace (any more). */
  forbidden: 4403,
  /** Too many sockets open, or too many frames sent. */
  tooManyRequests: 4429,
} as const;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), channel_id: z.uuid() }),
  z.object({ type: z.literal("unsubscribe"), channel_id: z.uuid() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ErrorCode = "bad_request" | "not_found" | "too_many_subscriptions" | "unavailable";

export type ServerMessage =
  | {
      readonly type: "ready";
      readonly user_id: string;
      readonly workspace_id: string;
      readonly channels: readonly string[];
    }
  | { readonly type: "pong" }
  | { readonly type: "event"; readonly event: ChatEvent }
  | { readonly type: "subscribed"; readonly channel_id: string }
  | { readonly type: "unsubscribed"; readonly channel_id: string; readonly reason: "requested" | "access_lost" }
  | { readonly type: "resync"; readonly reason: "events_missed" | "membership_changed" }
  | { readonly type: "error"; readonly code: ErrorCode; readonly message: string; readonly channel_id?: string };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
