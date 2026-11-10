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

const mocks = vi.hoisted(() => ({
  fetchPageDetails: vi.fn(),
  mutate: undefined as unknown,
  page: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@makeplane/propel/elements/button", () => ({ Button: () => null }));
vi.mock("@/components/common/logo-spinner", () => ({ LogoSpinner: () => <p>loading</p> }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/issues/peek-overview", () => ({ IssuePeekOverview: () => null }));
vi.mock("@/components/pages/editor/page-root", () => ({ PageRoot: () => <p>page editor</p> }));
vi.mock("@/hooks/editor", () => ({ useEditorConfig: () => ({ getEditorFileHandlers: () => ({}) }) }));
vi.mock("@/hooks/store/use-editor-asset", () => ({ useEditorAsset: () => ({}) }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws" }) }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/store", () => ({
  EPageStoreType: { PROJECT: "PROJECT_PAGE" },
  usePage: () => mocks.page,
  usePageStore: () => ({ createPage: vi.fn(), fetchPageDetails: mocks.fetchPageDetails }),
}));
vi.mock("@/services/workspace.service", () => ({ WorkspaceService: class {} }));
vi.mock("@/services/page", () => ({ ProjectPageService: class {}, ProjectPageVersionService: class {} }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import PageDetailsPage from "./page";

function CaptureMutate() {
  mocks.mutate = useSWRConfig().mutate;
  return null;
}

const params = { workspaceSlug: "workspace", projectId: "project", pageId: "page" };

function renderPage() {
  const Page = PageDetailsPage as unknown as (props: { params: typeof params }) => ReactElement;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <CaptureMutate />
      <Page params={params} />
    </SWRConfig>
  );
}

describe("PageDetailsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.page = { id: "page", name: "Page", canCurrentUserAccessPage: true };
  });

  it("keeps an open page when a background refresh fails", async () => {
    mocks.fetchPageDetails.mockResolvedValueOnce({ id: "page" }).mockRejectedValueOnce(new Error("502"));
    renderPage();
    await screen.findByText("page editor");

    await act(async () => {
      await (mocks.mutate as ScopedMutator)(`PAGE_DETAILS_${params.pageId}`).catch(() => undefined);
    });

    expect(mocks.fetchPageDetails).toHaveBeenCalledTimes(2);
    expect(screen.getByText("page editor")).toBeTruthy();
    expect(screen.queryByText("Page not found")).toBeNull();
  });

  it("shows not found when the first load fails, even if a list already put the page in the store", async () => {
    mocks.fetchPageDetails.mockRejectedValue(new Error("404"));
    renderPage();

    expect(await screen.findByText("Page not found")).toBeTruthy();
  });
});
