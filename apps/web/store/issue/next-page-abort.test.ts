/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { ALL_ISSUES } from "@plane/constants";
import type { TIssuesResponse } from "@plane/types";
import { ArchivedIssues } from "./archived/issue.store";
import { CycleIssues } from "./cycle/issue.store";
import type { IBaseIssuesStore } from "./helpers/base-issues.store";
import { ModuleIssues } from "./module/issue.store";
import { ProfileIssues } from "./profile/issue.store";
import { ProjectIssues } from "./project/issue.store";
import { ProjectViewIssues } from "./project-views/issue.store";
import type { IIssueRootStore } from "./root.store";
import { WorkspaceIssues } from "./workspace/issue.store";

// The issue helpers import the app's singleton root store, which these tests do not need.
vi.mock("@/lib/store-context", () => ({ store: {} }));

type TStore = IBaseIssuesStore & Record<string, any>;

const page: TIssuesResponse = {
  grouped_by: null,
  sub_grouped_by: null,
  total_count: 1,
  next_cursor: "100:2:0",
  prev_cursor: "100:0:0",
  next_page_results: true,
  prev_page_results: false,
  total_pages: 2,
  count: 1,
  total_results: 1,
  extra_stats: null,
  results: [{ id: "page-issue" }],
} as unknown as TIssuesResponse;

/** A page request held open until the test releases it, which honours the abort signal if it was given one. */
const heldRequest = () => {
  let resolveRequest: ((response: TIssuesResponse) => void) | undefined;
  const send = (config?: { signal?: AbortSignal }) =>
    new Promise<TIssuesResponse>((resolve, reject) => {
      config?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
      resolveRequest = resolve;
    });
  return { send, release: () => resolveRequest?.(page) };
};

const addIssue = vi.fn();
const rootStore = {
  rootStore: { router: {} },
  issues: { addIssue, getIssueById: vi.fn(), getIssuesByIds: (ids: string[]) => ids.map((id) => ({ id })) },
  issueDetail: { relation: { extractRelationsFromIssues: vi.fn() } },
} as unknown as IIssueRootStore;
const filterStore = { getFilterParams: () => ({}) } as never;

const cases: {
  name: string;
  build: () => TStore;
  service: (store: TStore) => [object, string];
  fetchNext: (store: TStore) => Promise<unknown>;
}[] = [
  {
    name: "project",
    build: () => new ProjectIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.issueService, "getIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "project-1"),
  },
  {
    name: "cycle",
    build: () => new CycleIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.issueService, "getIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "project-1", "cycle-1"),
  },
  {
    name: "module",
    build: () => new ModuleIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.issueService, "getIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "project-1", "module-1"),
  },
  {
    name: "project view",
    build: () => new ProjectViewIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.issueService, "getIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "project-1", "view-1"),
  },
  {
    name: "workspace view",
    build: () => new WorkspaceIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.workspaceService, "getViewIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "view-1"),
  },
  {
    name: "profile",
    build: () => new ProfileIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.userService, "getUserProfileIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "user-1"),
  },
  {
    name: "archived",
    build: () => new ArchivedIssues(rootStore, filterStore) as unknown as TStore,
    service: (store) => [store.issueArchiveService, "getArchivedIssues"],
    fetchNext: (store) => store.fetchNextIssues("acme", "project-1"),
  },
];

describe("fetchNextIssues after the list is reset", () => {
  it.each(cases)("$name: a page still loading is cancelled and never lands in the new list", async (testCase) => {
    const store = testCase.build();
    store.paginationOptions = { perPageCount: 100 } as never;
    const [service, method] = testCase.service(store);
    const held = heldRequest();
    const request = vi
      .spyOn(service as Record<string, (...args: unknown[]) => Promise<TIssuesResponse>>, method)
      .mockImplementation((...args: unknown[]) => held.send(args.at(-1) as { signal?: AbortSignal }));
    addIssue.mockClear();

    const nextPage = testCase.fetchNext(store);
    expect(request).toHaveBeenCalledOnce();

    // A filter or project change clears the store before fetching the new list,
    // and only then does the old page come back.
    store.clear();
    held.release();

    await expect(nextPage).rejects.toThrow("canceled");
    expect(addIssue).not.toHaveBeenCalled();
    expect(store.groupedIssueIds).toBeUndefined();
  });

  it("still applies a page that finishes before any reset", async () => {
    const store = new ProjectIssues(rootStore, filterStore) as unknown as TStore;
    store.paginationOptions = { perPageCount: 100 } as never;
    vi.spyOn(store.issueService, "getIssues").mockResolvedValue(page);
    addIssue.mockClear();

    await store.fetchNextIssues("acme", "project-1");

    expect(addIssue).toHaveBeenCalledWith(page.results);
    expect(store.groupedIssueIds).toEqual({ [ALL_ISSUES]: ["page-issue"] });
  });
});
