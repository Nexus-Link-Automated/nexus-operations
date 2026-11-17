/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: {} as Record<string, unknown> }));

vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    activity: {
      getActivityById: () => ({ id: "a1", workspace_detail: { slug: "acme" }, actor_detail: mocks.actor }),
    },
  }),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { IssueCreatorDisplay } from "./issue-creator";
// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { IssueUser } from "./issue-user";

describe("activity actor", () => {
  it.each([
    ["IssueUser", IssueUser],
    ["IssueCreatorDisplay", IssueCreatorDisplay],
  ])("%s names a bot without linking to a profile it does not have", (_name, Component) => {
    mocks.actor = { id: "bot1", is_bot: true, first_name: "Coding agent", display_name: "coding_agent_ab12" };
    render(<Component activityId="a1" />);
    expect(screen.getByText("Coding agent Bot")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("links a person to their profile", () => {
    mocks.actor = { id: "u1", is_bot: false, first_name: "Ada", display_name: "ada" };
    render(
      <MemoryRouter>
        <IssueUser activityId="a1" />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "ada" }).getAttribute("href")).toMatch(/^\/acme\/profile\/u1\/?$/);
  });
});
