/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  params: {} as { workspaceSlug?: string },
  currentWorkspace: null as { slug: string; name: string } | null,
  lastWorkspaceSlug: undefined as string | undefined,
}));

const WORKSPACES: Record<string, { slug: string; name: string }> = {
  acme: { slug: "acme", name: "Acme" },
  beta: { slug: "beta", name: "Beta" },
};

vi.mock("react-router", () => ({ useParams: () => mocks.params }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({
    currentWorkspace: mocks.currentWorkspace,
    getWorkspaceBySlug: (slug: string) => WORKSPACES[slug] ?? null,
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserSettings: () => ({ data: { workspace: { last_workspace_slug: mocks.lastWorkspaceSlug } } }),
}));
vi.mock("@/components/coding-machines/machines-settings", () => ({
  CodingMachinesSettings: ({ workspaceSlug, workspaceName }: { workspaceSlug: string; workspaceName: string }) => (
    <p>{`machines of ${workspaceSlug} (${workspaceName})`}</p>
  ),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { MachinesProfileSettings } from "./machines";

describe("MachinesProfileSettings", () => {
  beforeEach(() => {
    mocks.params = {};
    mocks.currentWorkspace = null;
    mocks.lastWorkspaceSlug = undefined;
  });

  it("uses the workspace the settings were opened in", () => {
    mocks.params = { workspaceSlug: "beta" };
    mocks.lastWorkspaceSlug = "acme";
    render(<MachinesProfileSettings />);
    expect(screen.getByText("machines of beta (Beta)")).toBeTruthy();
  });

  it("uses the workspace the user was last in outside a workspace route", () => {
    mocks.lastWorkspaceSlug = "acme";
    render(<MachinesProfileSettings />);
    expect(screen.getByText("machines of acme (Acme)")).toBeTruthy();
  });

  it("says machines need a workspace when there is none", () => {
    mocks.lastWorkspaceSlug = "gone";
    render(<MachinesProfileSettings />);
    expect(screen.getByText("coding_machines.no_workspace")).toBeTruthy();
  });
});
