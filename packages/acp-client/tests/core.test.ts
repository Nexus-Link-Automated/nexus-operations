/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@agentclientprotocol/sdk", () => {
  throw new Error("the core entry must not load the ACP SDK");
});
vi.mock("@agentclientprotocol/sdk/experimental/ws-client", () => {
  throw new Error("the core entry must not load the ACP SDK");
});

describe("core entry", () => {
  it("loads without the ACP SDK", async () => {
    const core = await import("../src/core.ts");
    expect(core.describeClose(core.AgentCloseCode.sessionExpired).autoReconnect).toBe(true);
    expect(new core.AgentRequestError(core.INVALID_PARAMS, "nope").code).toBe(-32602);
  });
});
