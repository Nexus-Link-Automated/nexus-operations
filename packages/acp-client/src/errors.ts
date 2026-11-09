/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { CloseInfo } from "./close-codes.ts";

/** JSON-RPC "invalid params": what the bridge answers to a `session/set_mode` above the admin max. */
export const INVALID_PARAMS = -32602;

/** ACP "authentication required": the agent has no usable credential (no key, a lost sign-in). */
export const AUTH_REQUIRED = -32000;

/** A JSON-RPC error answer from the agent or the bridge. */
export class AgentRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AgentRequestError";
    this.code = code;
    this.data = data;
  }
}

/** The request could not complete because the connection is gone (or was never opened). */
export class AgentDisconnectedError extends Error {
  readonly close: CloseInfo | null;

  constructor(close: CloseInfo | null) {
    super(close ? `Agent connection closed (${close.code})` : "Not connected to the agent");
    this.name = "AgentDisconnectedError";
    this.close = close;
  }
}
