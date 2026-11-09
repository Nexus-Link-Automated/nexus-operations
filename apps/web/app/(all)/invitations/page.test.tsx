/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isEmailVerified: false, userWorkspaceInvitations: vi.fn() }));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { email: "invitee@plane.so", is_email_verified: mocks.isEmailVerified } }),
  useUserProfile: () => ({ updateUserProfile: vi.fn() }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ fetchWorkspaces: vi.fn() }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/wrappers/authentication-wrapper", () => ({
  AuthenticationWrapper: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    userWorkspaceInvitations = mocks.userWorkspaceInvitations;
  },
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import UserInvitationsPage from "./page";

const page = () => (
  <MemoryRouter>
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <UserInvitationsPage />
    </SWRConfig>
  </MemoryRouter>
);

describe("UserInvitationsPage", () => {
  it("points to the emailed link until the email is verified", async () => {
    mocks.userWorkspaceInvitations.mockResolvedValue([
      { id: "invitation-1", role: 15, workspace: { id: "workspace-1", name: "Acme", slug: "acme", logo_url: "" } },
    ]);
    mocks.isEmailVerified = false;
    const unverified = render(page());

    const invitationButton = await screen.findByRole("button", { name: /Acme/ });
    expect(screen.getByRole("status").textContent).toContain("invitation link");
    expect((invitationButton as HTMLButtonElement).disabled).toBe(true);
    unverified.unmount();

    mocks.isEmailVerified = true;
    render(page());

    expect(((await screen.findByRole("button", { name: /Acme/ })) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
