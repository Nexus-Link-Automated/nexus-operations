/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IWorkspaceMemberInvitation } from "@plane/types";

const mocks = vi.hoisted(() => ({ isEmailVerified: false }));

vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { is_email_verified: mocks.isEmailVerified } }),
  useUserSettings: () => ({ fetchCurrentUserSettings: vi.fn() }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ fetchWorkspaces: vi.fn() }) }));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    joinWorkspaces = vi.fn();
  },
}));
vi.mock("@/components/workspace/logo", () => ({ WorkspaceLogo: () => null }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { WorkspaceJoinInvitesStep } from "./join-invites";

const invitation = {
  id: "invitation-1",
  role: 15,
  workspace: { id: "workspace-1", name: "Acme", slug: "acme", logo_url: "" },
} as IWorkspaceMemberInvitation;

const step = () => (
  <WorkspaceJoinInvitesStep
    invitations={[invitation]}
    handleNextStep={async () => undefined}
    handleCurrentViewChange={() => undefined}
  />
);

describe("WorkspaceJoinInvitesStep", () => {
  it("points to the emailed link until the email is verified", () => {
    mocks.isEmailVerified = false;
    const { rerender } = render(step());

    expect(screen.getByRole("status").textContent).toContain("invitation link");
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).toBe("true");

    mocks.isEmailVerified = true;
    rerender(step());

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("checkbox").getAttribute("aria-disabled")).not.toBe("true");
  });
});
