/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { act, render, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchFilters: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "workspace", projectId: "project", viewId: "view" }),
}));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({
    issuesFilter: { fetchFilters: mocks.fetchFilters, getIssueFilters: () => undefined, resetFilters: vi.fn() },
  }),
}));
vi.mock("@/hooks/store/use-project-view", () => ({ useProjectView: () => ({ getViewById: () => undefined }) }));
vi.mock("@/components/work-item-filters/filters-hoc/project-level", () => ({
  ProjectLevelWorkItemFiltersHOC: () => null,
}));
vi.mock("@/components/work-item-filters/filters-row", () => ({ WorkItemFiltersRow: () => null }));
vi.mock("../../peek-overview", () => ({ IssuePeekOverview: () => null }));
vi.mock("../calendar/roots/project-view-root", () => ({ ProjectViewCalendarLayout: () => null }));
vi.mock("../gantt", () => ({ BaseGanttRoot: () => null }));
vi.mock("../kanban/roots/project-view-root", () => ({ ProjectViewKanBanLayout: () => null }));
vi.mock("../list/roots/project-view-root", () => ({ ProjectViewListLayout: () => null }));
vi.mock("../spreadsheet/roots/project-view-root", () => ({ ProjectViewSpreadsheetLayout: () => null }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { ProjectViewLayoutRoot } from "./project-view-layout-root";

describe("ProjectViewLayoutRoot", () => {
  it("does not reload the saved view filters when the tab regains focus", async () => {
    mocks.fetchFilters.mockResolvedValue(undefined);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>
        <ProjectViewLayoutRoot />
      </SWRConfig>
    );
    await waitFor(() => expect(mocks.fetchFilters).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(mocks.fetchFilters).toHaveBeenCalledTimes(1);
  });
});
