/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";

// Each of these throws if a static import reaches it.
vi.mock("./panel", () => {
  throw new Error("the chat window must load only when it opens");
});
vi.mock("@plane/acp-client", () => {
  throw new Error("the ACP client must load only when a chat opens");
});
vi.mock("react-markdown", () => {
  throw new Error("the markdown renderer must load only with the chat window");
});
vi.mock("@/hooks/store/use-agent-chat", () => ({ useAgentChat: vi.fn() }));

describe("KhaiaWidget code loading", () => {
  it("keeps the chat window and what only it needs out of the static imports", async () => {
    const { KhaiaWidget } = await import("./root");
    expect(KhaiaWidget).toBeTruthy();
  });
});
