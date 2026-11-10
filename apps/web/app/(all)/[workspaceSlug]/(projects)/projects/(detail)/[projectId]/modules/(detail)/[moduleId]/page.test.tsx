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

const mocks = vi.hoisted(() => ({ fetchModuleDetails: vi.fn(), mutate: undefined as unknown }));

vi.mock("@plane/blocks/empty-state", () => ({ EmptyStateDetailed: ({ title }: { title: string }) => <p>{title}</p> }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/issues/issue-layouts/roots/module-layout-root", () => ({
  ModuleLayoutRoot: () => <p>module layout</p>,
}));
vi.mock("@/components/modules", () => ({ ModuleAnalyticsSidebar: () => null }));
vi.mock("@/hooks/store/use-module", () => ({
  useModule: () => ({ fetchModuleDetails: mocks.fetchModuleDetails, getModuleById: () => undefined }),
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: () => undefined }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-local-storage", () => ({ default: () => ({ setValue: vi.fn(), storedValue: "true" }) }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import ModuleIssuesPage from "./page";

function CaptureMutate() {
  mocks.mutate = useSWRConfig().mutate;
  return null;
}

const params = { workspaceSlug: "workspace", projectId: "project", moduleId: "module" };

function renderPage() {
  const Page = ModuleIssuesPage as unknown as (props: { params: typeof params }) => ReactElement;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <CaptureMutate />
      <Page params={params} />
    </SWRConfig>
  );
}

describe("ModuleIssuesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps an open module when a background refresh fails", async () => {
    mocks.fetchModuleDetails.mockResolvedValueOnce({ id: "module" }).mockRejectedValueOnce(new Error("502"));
    renderPage();
    await screen.findByText("module layout");

    await act(async () => {
      await (mocks.mutate as ScopedMutator)(`CURRENT_MODULE_DETAILS_${params.moduleId}`).catch(() => undefined);
    });

    expect(mocks.fetchModuleDetails).toHaveBeenCalledTimes(2);
    expect(screen.getByText("module layout")).toBeTruthy();
    expect(screen.queryByText("Module does not exist")).toBeNull();
  });

  it("shows not found when the module cannot be loaded at all", async () => {
    mocks.fetchModuleDetails.mockRejectedValue(new Error("404"));
    renderPage();

    expect(await screen.findByText("Module does not exist")).toBeTruthy();
  });
});
