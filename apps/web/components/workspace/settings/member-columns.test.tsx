/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EUserPermissions } from "@plane/constants";
import type { IUserLite } from "@plane/types";
import type { RowData } from "./member-columns";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ workspace: {} }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: undefined }), useUserPermissions: () => ({}) }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { NameColumn } from "./member-columns";

// What the members list passes as `rowData.member`: the member's user.
const user = (id: string, isBot: boolean): IUserLite => ({
  id,
  first_name: isBot ? "Triage" : "Ada",
  last_name: "",
  display_name: id,
  avatar_url: "",
  is_bot: isBot,
});

const renderName = (isBot: boolean) =>
  render(
    <NameColumn
      rowData={{
        member: user(isBot ? "bot1" : "u1", isBot) as unknown as RowData["member"],
        role: EUserPermissions.MEMBER,
        is_active: true,
      }}
      workspaceSlug="acme"
      isAdmin={false}
      currentUser={undefined}
      setRemoveMemberModal={vi.fn()}
    />
  );

describe("NameColumn", () => {
  it("shows a Bot badge next to a bot member", () => {
    renderName(true);
    expect(screen.getByText("Triage")).toBeTruthy();
    expect(screen.getByText("bot_members.badge")).toBeTruthy();
  });

  it("shows no badge for a person", () => {
    renderName(false);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.queryByText("bot_members.badge")).toBeNull();
  });
});
