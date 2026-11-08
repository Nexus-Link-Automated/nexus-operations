/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftIssueBlock } from "./draft-issue-block";

vi.mock("@/hooks/store/use-app-theme", () => ({ useAppTheme: () => ({ sidebarCollapsed: false }) }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectIdentifierById: () => "ACME" }) }));
vi.mock("@/hooks/store/workspace-draft", () => ({
  useWorkspaceDraftIssues: () => ({
    getIssueById: (id: string) => ({ id, name: "Draft", project_id: "project-1" }),
    updateIssue: () => undefined,
    deleteIssue: () => undefined,
  }),
}));
vi.mock("../issue-detail/identifier-text", () => ({ IdentifierText: () => null }));
vi.mock("../issue-modal/modal", () => ({ CreateUpdateIssueModal: () => null }));
vi.mock("./delete-modal", () => ({ WorkspaceDraftIssueDeleteIssueModal: () => null }));
vi.mock("./draft-issue-properties", () => ({ DraftIssueProperties: () => null }));
vi.mock("./quick-action", () => ({ WorkspaceDraftIssueQuickActions: () => <span data-testid="quick-actions" /> }));

const stubViewport = (isSingleLine: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isSingleLine,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

describe("DraftIssueBlock quick actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["single-line", true],
    ["stacked", false],
  ])("mounts one instance on a %s row", (_layout, isSingleLine) => {
    stubViewport(isSingleLine);
    render(<DraftIssueBlock workspaceSlug="acme" issueId="draft-1" />);

    expect(screen.getAllByTestId("quick-actions")).toHaveLength(1);
  });
});
