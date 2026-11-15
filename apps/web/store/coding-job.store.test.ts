/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import type { TCodingJob, TProjectCodingSettings } from "@plane/types";
import type { TCodingJobStoreService } from "./coding-job.store";
import { CodingJobStore } from "./coding-job.store";

const job = (id: string, overrides: Partial<TCodingJob> = {}): TCodingJob => ({
  id,
  workspace: "ws",
  project: "p1",
  work_item: "w1",
  action: "fix_bug",
  agent: "codex",
  status: "queued",
  outcome: null,
  result: {},
  pr_url: "",
  error_reason: "",
  retry_of: null,
  comment: null,
  requested_by: "u1",
  machine: null,
  is_active: true,
  is_retryable: false,
  started_at: null,
  finished_at: null,
  created_at: "2026-11-14T10:00:00Z",
  updated_at: "2026-11-14T10:00:00Z",
  ...overrides,
});

const settings = (overrides: Partial<TProjectCodingSettings> = {}): TProjectCodingSettings => ({
  project: "p1",
  enabled: true,
  repo_url: "https://github.com/acme/app",
  default_branch: "main",
  configured: true,
  ready_state: null,
  failed_state: null,
  in_review_state: null,
  columns: { ready: null, failed: null, in_review: null },
  updated_at: null,
  ...overrides,
});

function fakeService(overrides: Partial<TCodingJobStoreService> = {}) {
  return {
    list: vi.fn().mockResolvedValue([]),
    start: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(settings()),
    updateSettings: vi.fn(),
    ...overrides,
  } satisfies TCodingJobStoreService;
}

const refusal = (status: number, code: string, error = "Refused.") =>
  new CodingJobServiceError(status, { error, code });

describe("CodingJobStore", () => {
  it("lists a work item's jobs newest first", async () => {
    const service = fakeService({
      list: vi
        .fn()
        .mockResolvedValue([
          job("old", { created_at: "2026-11-13T10:00:00Z" }),
          job("new", { created_at: "2026-11-14T10:00:00Z" }),
        ]),
    });
    const store = new CodingJobStore({ service });

    await store.fetchJobs("acme", "p1", "w1");

    expect(service.list).toHaveBeenCalledWith("acme", "p1", "w1");
    expect(store.getJobs("w1")?.map((j) => j.id)).toEqual(["new", "old"]);
    expect(store.getJobs("other")).toBeUndefined();
  });

  it("starts a job and shows it at the top", async () => {
    const service = fakeService({
      start: vi.fn().mockResolvedValue(job("j2", { created_at: "2026-11-14T11:00:00Z", agent: "claude" })),
      list: vi.fn().mockResolvedValue([job("j1")]),
    });
    const store = new CodingJobStore({ service });
    await store.fetchJobs("acme", "p1", "w1");

    const started = await store.startJob("acme", "p1", "w1", "write_test", "claude", "m1");

    expect(service.start).toHaveBeenCalledWith("acme", "p1", "w1", {
      action: "write_test",
      agent: "claude",
      machine: "m1",
    });
    expect(started.id).toBe("j2");
    expect(store.getJobs("w1")?.map((j) => j.id)).toEqual(["j2", "j1"]);
  });

  it("cancels a job in place", async () => {
    const cancelled = job("j1", {
      status: "cancelled",
      outcome: "job_error",
      is_active: false,
      is_retryable: true,
      updated_at: "2026-11-14T10:05:00Z",
    });
    const service = fakeService({
      list: vi.fn().mockResolvedValue([job("j1")]),
      cancel: vi.fn().mockResolvedValue(cancelled),
    });
    const store = new CodingJobStore({ service });
    await store.fetchJobs("acme", "p1", "w1");

    await store.cancelJob("acme", "p1", "w1", "j1");

    expect(service.cancel).toHaveBeenCalledWith("acme", "p1", "w1", "j1");
    expect(store.getJobs("w1")).toEqual([cancelled]);
  });

  it("retries a job: the new job joins the list beside the old one", async () => {
    const failed = job("j1", { status: "finished", outcome: "job_error", is_active: false, is_retryable: true });
    const service = fakeService({
      list: vi.fn().mockResolvedValue([failed]),
      retry: vi.fn().mockResolvedValue(job("j2", { retry_of: "j1", created_at: "2026-11-14T12:00:00Z" })),
    });
    const store = new CodingJobStore({ service });
    await store.fetchJobs("acme", "p1", "w1");

    await store.retryJob("acme", "p1", "w1", "j1");

    expect(service.retry).toHaveBeenCalledWith("acme", "p1", "w1", "j1");
    expect(store.getJobs("w1")?.map((j) => j.id)).toEqual(["j2", "j1"]);
  });

  it("a list that was in flight during a change does not undo it", async () => {
    let resolveList!: (jobs: TCodingJob[]) => void;
    const service = fakeService({
      list: vi.fn().mockImplementation(() => new Promise<TCodingJob[]>((resolve) => (resolveList = resolve))),
      cancel: vi
        .fn()
        .mockResolvedValue(job("j1", { status: "cancelled", is_active: false, updated_at: "2026-11-14T10:05:00Z" })),
    });
    const store = new CodingJobStore({ service });

    const listing = store.fetchJobs("acme", "p1", "w1");
    await store.cancelJob("acme", "p1", "w1", "j1");
    resolveList([job("j1")]);
    await listing;

    expect(store.getJobs("w1")?.[0].status).toBe("cancelled");
  });

  it.each([
    ["JOB_ACTIVE", 409, "startJob"],
    ["JOB_NOT_ACTIVE", 409, "cancelJob"],
    ["JOB_NOT_RETRYABLE", 409, "retryJob"],
  ] as const)("throws %s and reloads the jobs", async (code, status, method) => {
    const error = refusal(status, code);
    const service = fakeService({
      start: vi.fn().mockRejectedValue(error),
      cancel: vi.fn().mockRejectedValue(error),
      retry: vi.fn().mockRejectedValue(error),
    });
    const store = new CodingJobStore({ service });

    const call =
      method === "startJob"
        ? store.startJob("acme", "p1", "w1", "fix_bug", "codex")
        : store[method]("acme", "p1", "w1", "j1");

    await expect(call).rejects.toBe(error);
    await vi.waitFor(() => expect(service.list).toHaveBeenCalledWith("acme", "p1", "w1"));
  });

  it("throws CODING_NOT_CONFIGURED and reloads the settings", async () => {
    const error = refusal(400, "CODING_NOT_CONFIGURED");
    const service = fakeService({
      start: vi.fn().mockRejectedValue(error),
      getSettings: vi.fn().mockResolvedValue(settings({ enabled: false, configured: false })),
    });
    const store = new CodingJobStore({ service });

    await expect(store.startJob("acme", "p1", "w1", "fix_bug", "codex")).rejects.toBe(error);

    await vi.waitFor(() => expect(store.getSettings("p1")?.configured).toBe(false));
    expect(service.list).not.toHaveBeenCalled();
  });

  it("throws WORK_ITEM_NOT_ELIGIBLE without reloading anything", async () => {
    const error = refusal(400, "WORK_ITEM_NOT_ELIGIBLE");
    const service = fakeService({ start: vi.fn().mockRejectedValue(error) });
    const store = new CodingJobStore({ service });

    await expect(store.startJob("acme", "p1", "w1", "fix_bug", "codex")).rejects.toBe(error);

    expect(service.list).not.toHaveBeenCalled();
    expect(service.getSettings).not.toHaveBeenCalled();
  });

  it("loads and saves settings per project", async () => {
    const service = fakeService({
      updateSettings: vi.fn().mockResolvedValue(settings({ failed_state: "s9" })),
    });
    const store = new CodingJobStore({ service });

    await store.fetchSettings("acme", "p1");
    expect(store.getSettings("p1")?.configured).toBe(true);

    await store.updateSettings("acme", "p1", { failed_state: "s9" });
    expect(service.updateSettings).toHaveBeenCalledWith("acme", "p1", { failed_state: "s9" });
    expect(store.getSettings("p1")?.failed_state).toBe("s9");
  });

  it("keeps the newest list when two list requests answer out of order", async () => {
    const answers: ((jobs: TCodingJob[]) => void)[] = [];
    const service = fakeService({
      list: vi.fn().mockImplementation(() => new Promise<TCodingJob[]>((resolve) => answers.push(resolve))),
    });
    const store = new CodingJobStore({ service });

    const older = store.fetchJobs("acme", "p1", "w1");
    const newer = store.fetchJobs("acme", "p1", "w1");
    answers[1]([job("j1", { status: "running" })]);
    await newer;
    answers[0]([job("j1")]);
    await older;

    expect(store.getJobs("w1")?.[0].status).toBe("running");
  });

  it("sends one settings request at a time per project", async () => {
    const service = fakeService();
    const store = new CodingJobStore({ service });

    await Promise.all([store.fetchSettings("acme", "p1"), store.fetchSettings("acme", "p1")]);

    expect(service.getSettings).toHaveBeenCalledTimes(1);
  });

  it("a settings read that started before a save does not undo it", async () => {
    let answer!: (value: TProjectCodingSettings) => void;
    const service = fakeService({
      getSettings: vi
        .fn()
        .mockImplementation(() => new Promise<TProjectCodingSettings>((resolve) => (answer = resolve))),
      updateSettings: vi.fn().mockResolvedValue(settings({ repo_url: "https://github.com/acme/new" })),
    });
    const store = new CodingJobStore({ service });

    const read = store.fetchSettings("acme", "p1");
    await store.updateSettings("acme", "p1", { repo_url: "https://github.com/acme/new" });
    answer(settings());
    await read;

    expect(store.getSettings("p1")?.repo_url).toBe("https://github.com/acme/new");
  });
});
