/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceAgentsPage from "./page";

let canUseAgents = true;
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => canUseAgents }),
}));
vi.mock("@/components/agents/root", () => ({ AgentChatRoot: () => <div>agent chat</div> }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/acme/agents/"]}>
      <Routes>
        <Route path="/:workspaceSlug/agents" element={<WorkspaceAgentsPage />} />
        <Route path="/:workspaceSlug" element={<div>workspace home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  canUseAgents = true;
});

describe("WorkspaceAgentsPage", () => {
  it("shows the chat to admins and members", () => {
    renderPage();
    expect(screen.getByText("agent chat")).toBeTruthy();
  });

  it("sends guests to the workspace home instead of a page that cannot load", () => {
    canUseAgents = false;
    renderPage();
    expect(screen.getByText("workspace home")).toBeTruthy();
    expect(screen.queryByText("agent chat")).toBeNull();
  });
});
