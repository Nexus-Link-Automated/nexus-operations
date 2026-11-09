/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";

// Each of these throws if a static import reaches it.
vi.mock("@plane/acp-client", () => {
  throw new Error("the ACP client must load only when a chat opens");
});

describe("agent chat code loading", () => {
  it("keeps the ACP client out of the store's static imports", async () => {
    const { AgentChatStore } = await import("./agent-chat.store");
    const store = new AgentChatStore({ agentService: { list: async () => [] } });
    expect(store.snapshot).toBeNull();
  });

  it("loads the ACP client when a chat opens, and reports a failure to fetch it", async () => {
    const { AgentChatStore } = await import("./agent-chat.store");
    const store = new AgentChatStore({ agentService: { list: async () => [] } });
    await store.openChat("acme", "agent-1");
    expect(store.error).toMatchObject({ kind: "unknown", action: "connect" });
    expect(store.isConnecting).toBe(false);
  });
});
