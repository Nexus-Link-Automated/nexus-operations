/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentsHeader } from "./header";
import WorkspaceAgentsPage from "./page";

const mocks = vi.hoisted(() => ({
  canUseAgents: true,
  pushed: [] as string[],
  openAgentDm: vi.fn(async (agentId: string) => ({ id: `adm-${agentId}` })),
  fetchAvailableAgents: vi.fn(async () => undefined),
  agentId: "agent-maia" as string | null,
}));

vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => mocks.canUseAgents }),
}));
vi.mock("@/components/agents/root", () => ({ AgentChatRoot: () => <div>agent chat</div> }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/hooks/store/use-agent-chat", () => ({
  useAgentChat: () => ({ agentId: mocks.agentId, workspaceSlug: "acme" }),
}));
vi.mock("@/hooks/store/use-chat", () => ({
  useChat: () => ({
    availableAgents: [
      {
        id: "agent-first",
        name: "First",
        slug: "first",
        description: "",
        adapter: "claude",
        default_permission_level: "ask_writes",
        max_permission_level: "ask_writes",
        credential_source: "instance",
      },
    ],
    fetchAvailableAgents: mocks.fetchAvailableAgents,
    openAgentDm: mocks.openAgentDm,
  }),
}));
vi.mock("@/hooks/use-app-router", () => ({
  useAppRouter: () => ({
    push: (href: string) => mocks.pushed.push(href),
    replace: (href: string) => mocks.pushed.push(href),
  }),
}));

function renderPage(element: React.ReactNode = <WorkspaceAgentsPage />) {
  return render(
    <MemoryRouter initialEntries={["/acme/agents/"]}>
      <Routes>
        <Route path="/:workspaceSlug/agents" element={element} />
        <Route path="/:workspaceSlug" element={<div>workspace home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mocks.canUseAgents = true;
  mocks.pushed = [];
  mocks.agentId = "agent-maia";
  mocks.openAgentDm.mockClear();
});

describe("WorkspaceAgentsPage", () => {
  it("shows the chat to admins and members", () => {
    renderPage();
    expect(screen.getByText("agent chat")).toBeTruthy();
  });

  it("sends guests to the workspace home instead of a page that cannot load", () => {
    mocks.canUseAgents = false;
    renderPage();
    expect(screen.getByText("workspace home")).toBeTruthy();
    expect(screen.queryByText("agent chat")).toBeNull();
  });

  it("keeps the earlier chats, with a banner that opens the agent's conversation in Messages", async () => {
    renderPage();
    expect(screen.getByText("Agent chats have moved to Messages")).toBeTruthy();
    expect(screen.getByText("agent chat")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open in Messages" }));
    expect(mocks.openAgentDm).toHaveBeenCalledWith("agent-maia");
    await vi.waitFor(() => expect(mocks.pushed).toEqual(["/acme/messages/adm-agent-maia"]));
  });
});

describe("WorkspaceAgentsHeader", () => {
  it("starts a new chat as the agent's conversation in Messages", async () => {
    renderPage(<WorkspaceAgentsHeader />);
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(mocks.openAgentDm).toHaveBeenCalledWith("agent-maia");
    await vi.waitFor(() => expect(mocks.pushed).toEqual(["/acme/messages/adm-agent-maia"]));
  });

  it("opens the first usable agent when none is chosen yet", async () => {
    mocks.agentId = null;
    renderPage(<WorkspaceAgentsHeader />);
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(mocks.openAgentDm).toHaveBeenCalledWith("agent-first");
    await vi.waitFor(() => expect(mocks.pushed).toEqual(["/acme/messages/adm-agent-first"]));
  });
});
