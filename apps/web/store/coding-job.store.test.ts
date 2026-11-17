/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import type { TCodingJob, TCodingJobEvent, TProjectCodingSettings } from "@plane/types";
import type { TCodingJobStoreService } from "./coding-job.store";
import { CODING_JOB_POLL_MS, CodingJobStore } from "./coding-job.store";

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
  ran_on: null,
  ran_on_name: "",
  progress: "",
  progress_at: null,
  deadline_at: null,
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
    listEvents: vi.fn().mockResolvedValue({ results: [], has_more: false }),
    ...overrides,
  } satisfies TCodingJobStoreService;
}

const event = (seq: number, text = `line ${seq}`): TCodingJobEvent => ({
  seq,
  kind: "message",
  text,
  created_at: "2026-11-17T10:00:00Z",
});

const running = (id = "j1") => job(id, { status: "running", ran_on: "m1", ran_on_name: "Laptop" });
const finished = (id = "j1") =>
  job(id, { status: "finished", outcome: "fixed", is_active: false, updated_at: "2026-11-14T10:30:00Z" });

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

  describe("live updates", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    const tick = () => vi.advanceTimersByTimeAsync(CODING_JOB_POLL_MS);

    it("reloads a shown work item's jobs every 5 s while one is active, and stops when none is", async () => {
      const list = vi
        .fn()
        .mockResolvedValueOnce([job("j1")])
        .mockResolvedValueOnce([running()])
        .mockResolvedValue([finished()]);
      const store = new CodingJobStore({ service: fakeService({ list }) });
      await store.fetchJobs("acme", "p1", "w1");
      const stop = store.watchJobs("acme", "p1", "w1");

      await vi.advanceTimersByTimeAsync(CODING_JOB_POLL_MS - 1);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledTimes(2);
      expect(store.getJobs("w1")?.[0].ran_on_name).toBe("Laptop");
      await tick();
      expect(list).toHaveBeenCalledTimes(3);
      expect(store.getJobs("w1")?.[0].status).toBe("finished");
      await tick();
      await tick();
      expect(list).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
      stop();
    });

    it("waits while no job is active and starts when one is started", async () => {
      const list = vi.fn().mockResolvedValue([finished("j1")]);
      const start = vi.fn().mockResolvedValue(job("j2", { created_at: "2026-11-14T11:00:00Z" }));
      const store = new CodingJobStore({ service: fakeService({ list, start }) });
      await store.fetchJobs("acme", "p1", "w1");
      const stop = store.watchJobs("acme", "p1", "w1");

      await tick();
      expect(list).toHaveBeenCalledTimes(1);

      await store.startJob("acme", "p1", "w1", "fix_bug", "codex");
      list.mockResolvedValue([job("j2", { created_at: "2026-11-14T11:00:00Z" }), finished("j1")]);
      await tick();
      expect(list).toHaveBeenCalledTimes(2);
      stop();
    });

    it("stops when the panel goes away, sharing one timer between watchers", async () => {
      const list = vi.fn().mockResolvedValue([running()]);
      const store = new CodingJobStore({ service: fakeService({ list }) });
      await store.fetchJobs("acme", "p1", "w1");
      const stopFirst = store.watchJobs("acme", "p1", "w1");
      const stopSecond = store.watchJobs("acme", "p1", "w1");

      await tick();
      expect(list).toHaveBeenCalledTimes(2);
      stopFirst();
      stopFirst();
      await tick();
      expect(list).toHaveBeenCalledTimes(3);
      stopSecond();
      expect(vi.getTimerCount()).toBe(0);
      await tick();
      expect(list).toHaveBeenCalledTimes(3);
    });

    it("skips ticks while the tab is hidden and keeps going after a failed reload", async () => {
      const list = vi.fn().mockResolvedValue([running()]);
      const store = new CodingJobStore({ service: fakeService({ list }) });
      await store.fetchJobs("acme", "p1", "w1");
      const stop = store.watchJobs("acme", "p1", "w1");

      vi.stubGlobal("document", { hidden: true });
      await tick();
      await tick();
      expect(list).toHaveBeenCalledTimes(1);

      vi.stubGlobal("document", { hidden: false });
      list.mockRejectedValueOnce(refusal(500, ""));
      await tick();
      await tick();
      expect(list).toHaveBeenCalledTimes(3);
      stop();
    });

    it("loads a job's events page by page, then only the new ones", async () => {
      const listEvents = vi
        .fn()
        .mockResolvedValueOnce({ results: [event(1), event(2)], has_more: true })
        .mockResolvedValueOnce({ results: [event(3)], has_more: false })
        .mockResolvedValueOnce({ results: [event(3), event(4)], has_more: false });
      const store = new CodingJobStore({ service: fakeService({ listEvents }) });

      await store.fetchEvents("acme", "p1", "w1", "j1");
      expect(listEvents.mock.calls).toEqual([
        ["acme", "p1", "w1", "j1", undefined],
        ["acme", "p1", "w1", "j1", 2],
      ]);
      expect(store.getEvents("j1")?.map((e) => e.seq)).toEqual([1, 2, 3]);

      await store.fetchEvents("acme", "p1", "w1", "j1");
      expect(listEvents).toHaveBeenLastCalledWith("acme", "p1", "w1", "j1", 3);
      expect(store.getEvents("j1")?.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it("sends one events request at a time per job", async () => {
      const service = fakeService();
      const store = new CodingJobStore({ service });

      await Promise.all([store.fetchEvents("acme", "p1", "w1", "j1"), store.fetchEvents("acme", "p1", "w1", "j1")]);

      expect(service.listEvents).toHaveBeenCalledTimes(1);
      expect(store.getEvents("j1")).toEqual([]);
    });

    it("follows a running job's events, once more when it ends, then stops", async () => {
      const list = vi.fn().mockResolvedValue([running()]);
      const listEvents = vi
        .fn()
        .mockResolvedValueOnce({ results: [event(1)], has_more: false })
        .mockResolvedValueOnce({ results: [event(2)], has_more: false })
        .mockResolvedValue({ results: [event(3, "Done.")], has_more: false });
      const store = new CodingJobStore({ service: fakeService({ list, listEvents }) });
      await store.fetchJobs("acme", "p1", "w1");
      const stopJobs = store.watchJobs("acme", "p1", "w1");
      await store.fetchEvents("acme", "p1", "w1", "j1");
      const stopEvents = store.watchEvents("acme", "p1", "w1", "j1");

      await tick();
      expect(listEvents).toHaveBeenLastCalledWith("acme", "p1", "w1", "j1", 1);
      expect(store.getEvents("j1")?.map((e) => e.seq)).toEqual([1, 2]);

      list.mockResolvedValue([finished()]);
      await tick();
      expect(store.getJobs("w1")?.[0].status).toBe("finished");
      await vi.waitFor(() => expect(store.getEvents("j1")?.map((e) => e.seq)).toEqual([1, 2, 3]));
      const calls = listEvents.mock.calls.length;
      await tick();
      await tick();
      expect(listEvents).toHaveBeenCalledTimes(calls);
      expect(vi.getTimerCount()).toBe(0);
      stopEvents();
      stopJobs();
    });

    it("does not follow the events of a job that has ended", async () => {
      const service = fakeService({ list: vi.fn().mockResolvedValue([finished()]) });
      const store = new CodingJobStore({ service });
      await store.fetchJobs("acme", "p1", "w1");

      const stop = store.watchEvents("acme", "p1", "w1", "j1");
      await tick();

      expect(service.listEvents).not.toHaveBeenCalled();
      stop();
    });
  });
});
