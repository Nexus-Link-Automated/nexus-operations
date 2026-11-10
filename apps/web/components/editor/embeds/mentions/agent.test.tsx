/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ names: {} as Record<string, string> }));

vi.mock("@/hooks/store/use-chat", () => ({
  useChat: () => ({ getAgentName: (id: string) => mocks.names[id] }),
}));
vi.mock("./user", () => ({ EditorUserMention: ({ id }: { id: string }) => <span>user {id}</span> }));

const { EditorMentionsRoot } = await import("./root");

describe("agent mentions", () => {
  it("names the agent, marked apart from a person's mention", () => {
    mocks.names = { "agent-1": "Maia" };
    const { container } = render(<EditorMentionsRoot entity_name="agent_mention" entity_identifier="agent-1" />);
    expect(screen.getByText("@Maia")).toBeTruthy();
    expect(container.querySelector("[data-agent-mention='agent-1']")).toBeTruthy();
    expect(screen.queryByText(/^user /)).toBeNull();
  });

  it("calls an agent it doesn't know just an agent", async () => {
    mocks.names = {};
    const { container } = render(<EditorMentionsRoot entity_name="agent_mention" entity_identifier="gone" />);
    // The translations load asynchronously.
    await vi.waitFor(() => expect(container.querySelector("[data-agent-mention='gone']")!.textContent).toBe("@Agent"));
  });

  it("leaves people's mentions as they were", () => {
    render(<EditorMentionsRoot entity_name="user_mention" entity_identifier="u1" />);
    expect(screen.getByText("user u1")).toBeTruthy();
  });
});
