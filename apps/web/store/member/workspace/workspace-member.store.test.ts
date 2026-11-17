/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { EUserPermissions } from "@plane/constants";
import type { IUserLite } from "@plane/types";
import type { IMemberRootStore } from "../index.ts";
import type { RootStore } from "@/store/root.store";
import { WorkspaceMemberStore } from "./workspace-member.store";

const user = (id: string, overrides: Partial<IUserLite> = {}): IUserLite => ({
  id,
  display_name: id,
  first_name: id,
  last_name: "",
  avatar_url: "",
  is_bot: false,
  ...overrides,
});

describe("WorkspaceMemberStore", () => {
  it("lists bot members in the settings list and pickers, but not Plane's own bot users", () => {
    const memberMap = {
      ada: user("ada"),
      triage: user("triage", { is_bot: true, bot_type: "EMPLOYAI" }),
      reviewer: user("reviewer", { is_bot: true, bot_type: "EMPLOYAI" }),
      seed: user("seed", { is_bot: true, bot_type: "WORKSPACE_SEED", display_name: "Plane" }),
    };
    const store = new WorkspaceMemberStore(
      { memberMap } as unknown as IMemberRootStore,
      { router: { workspaceSlug: "acme" }, user: { data: { id: "ada" } } } as unknown as RootStore
    );
    store.workspaceMemberMap = {
      acme: {
        ada: { id: "1", member: "ada", role: EUserPermissions.ADMIN },
        triage: { id: "2", member: "triage", role: EUserPermissions.MEMBER },
        reviewer: { id: "3", member: "reviewer", role: EUserPermissions.GUEST },
        seed: { id: "4", member: "seed", role: EUserPermissions.ADMIN },
      },
    };

    const ids = store.getFilteredWorkspaceMemberIds("acme");
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(expect.arrayContaining(["ada", "reviewer", "triage"]));
    // Pickers (adding to a project, assignees) offer bot members too, never Plane's own bots.
    expect(store.getWorkspaceMemberIds("acme")).toEqual(expect.arrayContaining(["ada", "reviewer", "triage"]));
    expect(store.getWorkspaceMemberIds("acme")).not.toContain("seed");
  });
});
