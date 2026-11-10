/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactElement, ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import type { ScopedMutator } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchIssueWithIdentifier: vi.fn(), mutate: undefined as unknown }));
const issue = { id: "issue", project_id: "project", sequence_id: 1, name: "Item" };

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/empty-state", () => ({ EmptyStateDetailed: ({ title }: { title: string }) => <p>{title}</p> }));
vi.mock("@plane/blocks/skeleton", () => ({ Loader: Object.assign(() => <p>loading</p>, { Item: () => null }) }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/browse/workItem-detail", () => ({ WorkItemDetailRoot: () => <p>work item detail</p> }));
vi.mock("@/layouts/auth-layout/project-wrapper", () => ({
  ProjectAuthWrapper: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/hooks/store/use-app-theme", () => ({
  useAppTheme: () => ({ toggleIssueDetailSidebar: vi.fn(), issueDetailSidebarCollapsed: false }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    fetchIssueWithIdentifier: mocks.fetchIssueWithIdentifier,
    issue: { getIssueById: (id: string) => (id === issue.id ? issue : undefined) },
  }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: () => ({ identifier: "PROJ" }), getProjectByIdentifier: () => undefined }),
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-issue-properties", () => ({ useWorkItemProperties: vi.fn() }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { IssueDetailsPage } from "./page";

function CaptureMutate() {
  mocks.mutate = useSWRConfig().mutate;
  return null;
}

const params = { workspaceSlug: "workspace", workItem: "PROJ-1" };
const swrKey = "ISSUE_DETAIL_workspace_PROJ_1";

function renderPage() {
  const Page = IssueDetailsPage as unknown as (props: { params: typeof params }) => ReactElement;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <CaptureMutate />
      <Page params={params} />
    </SWRConfig>
  );
}

async function revalidate() {
  await act(async () => {
    await (mocks.mutate as ScopedMutator)(swrKey).catch(() => undefined);
  });
}

describe("IssueDetailsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps an open work item when a background refresh fails", async () => {
    mocks.fetchIssueWithIdentifier.mockResolvedValueOnce(issue).mockRejectedValueOnce({ status: 502 });
    renderPage();
    await screen.findByText("work item detail");

    await revalidate();

    expect(mocks.fetchIssueWithIdentifier).toHaveBeenCalledTimes(2);
    expect(screen.getByText("work item detail")).toBeTruthy();
    expect(screen.queryByText("issue.empty_state.issue_detail.title")).toBeNull();
  });

  it("shows not found when an open work item turns out to be deleted", async () => {
    mocks.fetchIssueWithIdentifier.mockResolvedValueOnce(issue).mockRejectedValueOnce({ status: 404 });
    renderPage();
    await screen.findByText("work item detail");

    await revalidate();

    expect(screen.getByText("issue.empty_state.issue_detail.title")).toBeTruthy();
  });

  it("shows not found when the work item cannot be loaded at all", async () => {
    mocks.fetchIssueWithIdentifier.mockRejectedValue({ status: 502 });
    renderPage();

    expect(await screen.findByText("issue.empty_state.issue_detail.title")).toBeTruthy();
  });
});
