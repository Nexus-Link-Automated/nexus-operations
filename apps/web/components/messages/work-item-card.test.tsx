/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { TChatMessageReference } from "@plane/types";
import { ChatWorkItemCard } from "./work-item-card";

const reference = (overrides: Partial<TChatMessageReference> = {}): TChatMessageReference => ({
  id: "i1",
  project: "p1",
  key: "EMP-142",
  name: "Fix the gateway",
  priority: "high",
  state: { name: "In Review", group: "started", color: "#f59e0b" },
  ...overrides,
});

const card = (overrides?: Partial<TChatMessageReference>) =>
  render(
    <MemoryRouter>
      <ChatWorkItemCard reference={reference(overrides)} workspaceSlug="acme" />
    </MemoryRouter>
  );

describe("ChatWorkItemCard", () => {
  it("shows the key, name, state and priority, and links to the work item", () => {
    card();
    expect(screen.getByText("EMP-142")).toBeTruthy();
    expect(screen.getByText("Fix the gateway")).toBeTruthy();
    expect(screen.getByText("In Review")).toBeTruthy();
    expect(screen.getByText(/high/i)).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/acme/browse/EMP-142/");
  });

  it("leaves out a priority that isn't set", () => {
    card({ priority: "none" });
    expect(screen.queryByText(/none/i)).toBeNull();
  });
});
