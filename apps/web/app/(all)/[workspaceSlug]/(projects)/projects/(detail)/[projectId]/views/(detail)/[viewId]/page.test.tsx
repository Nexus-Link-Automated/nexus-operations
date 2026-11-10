/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import type { ScopedMutator } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchViewDetails: vi.fn(), mutate: undefined as unknown }));

vi.mock("@plane/blocks/empty-state", () => ({ EmptyStateDetailed: ({ title }: { title: string }) => <p>{title}</p> }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/issues/issue-layouts/roots/project-view-layout-root", () => ({
  ProjectViewLayoutRoot: () => <p>view layout</p>,
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: () => undefined }) }));
vi.mock("@/hooks/store/use-project-view", () => ({
  useProjectView: () => ({ fetchViewDetails: mocks.fetchViewDetails, getViewById: () => undefined }),
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import ProjectViewIssuesPage from "./page";

function CaptureMutate() {
  mocks.mutate = useSWRConfig().mutate;
  return null;
}

const params = { workspaceSlug: "workspace", projectId: "project", viewId: "view" };

function renderPage() {
  const Page = ProjectViewIssuesPage as unknown as (props: { params: typeof params }) => ReactElement;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <CaptureMutate />
      <Page params={params} />
    </SWRConfig>
  );
}

describe("ProjectViewIssuesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps an open view when a background refresh fails", async () => {
    mocks.fetchViewDetails.mockResolvedValueOnce({ id: "view" }).mockRejectedValueOnce(new Error("502"));
    renderPage();
    await screen.findByText("view layout");

    await act(async () => {
      await (mocks.mutate as ScopedMutator)(`VIEW_DETAILS_${params.viewId}`).catch(() => undefined);
    });

    expect(mocks.fetchViewDetails).toHaveBeenCalledTimes(2);
    expect(screen.getByText("view layout")).toBeTruthy();
    expect(screen.queryByText("View does not exist")).toBeNull();
  });

  it("shows not found when the view cannot be loaded at all", async () => {
    mocks.fetchViewDetails.mockRejectedValue(new Error("404"));
    renderPage();

    expect(await screen.findByText("View does not exist")).toBeTruthy();
  });
});
