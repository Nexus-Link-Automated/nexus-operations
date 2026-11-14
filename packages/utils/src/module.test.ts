/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import type { IModule } from "@plane/types";
import { getModuleProgress, orderModules } from "./module";

const buildModule = (id: string, counts: Partial<IModule>): IModule =>
  ({
    id,
    name: id,
    total_issues: 0,
    completed_issues: 0,
    cancelled_issues: 0,
    ...counts,
  }) as IModule;

describe("getModuleProgress", () => {
  it("leaves cancelled work items out of the scope", () => {
    const module = buildModule("m", { total_issues: 10, completed_issues: 8, cancelled_issues: 2 });
    expect(getModuleProgress(module)).toEqual({ completed: 8, scope: 8, percentage: 100 });
  });

  it("does not count cancelled work items as done", () => {
    const module = buildModule("m", { total_issues: 10, completed_issues: 4, cancelled_issues: 2 });
    expect(getModuleProgress(module)).toEqual({ completed: 4, scope: 8, percentage: 50 });
  });

  it("rounds down so 100% only shows when nothing is left", () => {
    const module = buildModule("m", { total_issues: 200, completed_issues: 199 });
    expect(getModuleProgress(module).percentage).toBe(99);
  });

  it("is zero for an empty or fully cancelled module", () => {
    expect(getModuleProgress(buildModule("m", {}))).toEqual({ completed: 0, scope: 0, percentage: 0 });
    expect(getModuleProgress(buildModule("m", { total_issues: 3, cancelled_issues: 3 }))).toEqual({
      completed: 0,
      scope: 0,
      percentage: 0,
    });
  });

  it("uses estimate points when asked, treating missing points as zero", () => {
    const module = buildModule("m", {
      total_issues: 4,
      completed_issues: 1,
      total_estimate_points: 20,
      completed_estimate_points: 9,
      cancelled_estimate_points: 2,
    });
    expect(getModuleProgress(module, "points")).toEqual({ completed: 9, scope: 18, percentage: 50 });
    expect(getModuleProgress(buildModule("m", {}), "points")).toEqual({ completed: 0, scope: 0, percentage: 0 });
  });

  it("caps completed at the scope when the counts disagree", () => {
    const module = buildModule("m", { total_issues: 5, completed_issues: 5, cancelled_issues: 1 });
    expect(getModuleProgress(module)).toEqual({ completed: 4, scope: 4, percentage: 100 });
  });
});

describe("orderModules by progress", () => {
  const modules = [
    buildModule("half-done", { total_issues: 4, completed_issues: 2 }),
    buildModule("all-cancelled", { total_issues: 3, cancelled_issues: 3 }),
    buildModule("done-with-cancelled", { total_issues: 10, completed_issues: 8, cancelled_issues: 2 }),
    buildModule("empty", {}),
  ];

  it("sorts with the same progress the module views show", () => {
    expect(orderModules(modules, "progress").map((m) => m.id)).toEqual([
      "all-cancelled",
      "empty",
      "half-done",
      "done-with-cancelled",
    ]);
    expect(orderModules(modules, "-progress").map((m) => m.id)).toEqual([
      "done-with-cancelled",
      "half-done",
      "all-cancelled",
      "empty",
    ]);
  });
});
