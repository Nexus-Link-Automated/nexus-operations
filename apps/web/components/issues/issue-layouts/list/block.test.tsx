/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "@plane/blocks/context-menu";
import type { TIssue, TIssueMap } from "@plane/types";
import type { TSelectionHelper } from "@/hooks/use-multiple-select";
import { IssueBlock } from "./block";
import type { TRenderQuickActions } from "./list-view-types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "acme", projectId: "project-1" }),
}));
vi.mock("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({ draggable: () => () => undefined }));
vi.mock("@/hooks/store/use-app-theme", () => ({ useAppTheme: () => ({ sidebarCollapsed: false }) }));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectIdentifierById: () => "ACME", currentProjectNextSequenceId: 10 }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    getIsIssuePeeked: () => false,
    peekIssue: undefined,
    setPeekIssue: () => undefined,
    subIssues: { fetchSubIssues: () => undefined },
  }),
}));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/components/core/multiple-select", () => ({ MultipleSelectEntityAction: () => null }));
vi.mock("@/components/issues/issue-detail/issue-identifier", () => ({ IssueIdentifier: () => null }));
vi.mock("@/components/issues/issue-layouts/properties", () => ({ IssueProperties: () => null }));
vi.mock("../utils", () => ({ calculateIdentifierWidth: () => 0 }));

const ISSUE = { id: "issue-1", name: "Row", project_id: "project-1", sequence_id: 1 } as TIssue;

const SELECTION_HELPERS = {
  getIsEntitySelected: () => false,
  getIsEntityActive: () => false,
  isSelectionDisabled: true,
} as unknown as TSelectionHelper;

const stubViewport = (isSingleLine: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: isSingleLine,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

const renderRow = (issue: TIssue, quickActions: TRenderQuickActions) => {
  const issuesMap: TIssueMap = { [issue.id]: issue };
  return render(
    <IssueBlock
      issueId={issue.id}
      issuesMap={issuesMap}
      groupId="all"
      updateIssue={undefined}
      quickActions={quickActions}
      displayProperties={undefined}
      canEditProperties={() => true}
      nestingLevel={0}
      isExpanded={false}
      setExpanded={() => undefined}
      selectionHelpers={SELECTION_HELPERS}
      isCurrentBlockDragging={false}
      setIsCurrentBlockDragging={() => undefined}
      canDrag={false}
    />
  );
};

const renderQuickActionsStub: TRenderQuickActions = () => <span data-testid="quick-actions" />;

describe("IssueBlock quick actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["single-line", true],
    ["stacked", false],
  ])("mounts one instance on a %s row", (_layout, isSingleLine) => {
    stubViewport(isSingleLine);
    renderRow(ISSUE, renderQuickActionsStub);

    expect(screen.getAllByTestId("quick-actions")).toHaveLength(1);
  });

  it("hands the quick actions a ref to the row, where the context menu listens", () => {
    let parentRef: React.RefObject<HTMLElement | null> | undefined;
    const { container } = renderRow(ISSUE, (args) => {
      parentRef = args.parentRef;
      return null;
    });

    expect(parentRef?.current).toBe(container.querySelector(".group\\/list-block"));
  });

  it("opens one context menu on a right click", async () => {
    const { container } = renderRow(ISSUE, ({ parentRef }) => (
      <ContextMenu parentRef={parentRef} items={[{ key: "edit", title: "Edit", action: () => undefined }]} />
    ));

    fireEvent.contextMenu(container.querySelector(".group\\/list-block") as HTMLElement);

    expect(await screen.findAllByRole("menu")).toHaveLength(1);
  });

  it("mounts none while the work item is still being created", () => {
    renderRow({ ...ISSUE, tempId: "temp-1" } as TIssue, renderQuickActionsStub);

    expect(screen.queryByTestId("quick-actions")).toBeNull();
  });
});
