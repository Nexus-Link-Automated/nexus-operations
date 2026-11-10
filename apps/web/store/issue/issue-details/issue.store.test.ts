/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { EIssueServiceType } from "@plane/types";
import { IssueStore } from "./issue.store";
import type { IIssueDetail } from "./root.store";

const makeStore = (serviceType: EIssueServiceType, action: "removeIssue" | "archiveIssue", result: Promise<void>) => {
  const issues = { removeIssue: vi.fn(), archiveIssue: vi.fn() };
  const epics = { removeIssue: vi.fn(), archiveIssue: vi.fn() };
  (serviceType === EIssueServiceType.EPICS ? epics : issues)[action].mockReturnValue(result);
  const root = { rootIssueStore: { projectIssues: issues, projectEpics: epics } } as unknown as IIssueDetail;
  return new IssueStore(root, serviceType);
};

describe.each([EIssueServiceType.ISSUES, EIssueServiceType.EPICS])("IssueStore (%s)", (serviceType) => {
  it.each(["removeIssue", "archiveIssue"] as const)("%s rejects when the request fails", async (action) => {
    const failure = new Error("server refused");
    const store = makeStore(serviceType, action, Promise.reject(failure));

    await expect(store[action]("acme", "project-1", "issue-1")).rejects.toBe(failure);
  });

  it.each(["removeIssue", "archiveIssue"] as const)("%s resolves only after the request does", async (action) => {
    let finishRequest!: () => void;
    const request = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    const store = makeStore(serviceType, action, request);

    let settled = false;
    const pending = store[action]("acme", "project-1", "issue-1").finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishRequest();
    await pending;
    expect(settled).toBe(true);
  });
});
