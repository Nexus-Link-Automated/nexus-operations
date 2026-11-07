/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * What the gateway and a browser say to each other: JSON text frames, each an object with a `type`.
 *
 * Browser → gateway: `ping`.
 * Gateway → browser: `ready` once the socket is admitted, `pong`, and `error` for a frame it can't use.
 *
 * The socket only ever carries events out. Sending, editing and everything else goes through the REST API.
 */

/** Application close codes the browser sees (RFC 6455 reserves 4000-4999 for applications). */
export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  internalError: 1011,
  /** The URL or a frame is wrong; reconnecting as-is will fail again. */
  badRequest: 4400,
  /** No cookie, or the API does not accept it: sign in again. */
  unauthenticated: 4401,
  /** Signed in, but not a member of this workspace (any more). */
  forbidden: 4403,
  /** Too many sockets open, or too many frames sent. */
  tooManyRequests: 4429,
} as const;

export type ServerMessage =
  | { readonly type: "ready"; readonly user_id: string; readonly workspace_id: string }
  | { readonly type: "pong" }
  | { readonly type: "error"; readonly code: "bad_request"; readonly message: string };

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
