/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, reaction, runInAction } from "mobx";
import { CodingJobService, CodingJobServiceError } from "@plane/services";
import type {
  TCodingAction,
  TCodingAgent,
  TCodingJob,
  TCodingJobEvent,
  TCodingJobStatus,
  TProjectCodingSettings,
  TProjectCodingSettingsUpdate,
} from "@plane/types";

/** The REST calls the store makes. `CodingJobService` in the app; a fake in tests. */
export type TCodingJobStoreService = Pick<
  CodingJobService,
  "list" | "start" | "cancel" | "retry" | "getSettings" | "updateSettings" | "listEvents"
>;

/** How often a shown work item's jobs, and an open job's progress, reload while a job is queued or running. */
export const CODING_JOB_POLL_MS = 5_000;

const ACTIVE_STATUSES = new Set<TCodingJobStatus>(["queued", "running", "needs_input"]);

/** Queued, running or waiting for input: the job can still change. */
export const isCodingJobActive = (job: Pick<TCodingJob, "status">) => ACTIVE_STATUSES.has(job.status);

// The API keeps a job's latest 500 events and answers 200 at a time; this caps one load at 1000 regardless.
const MAX_EVENT_PAGES = 5;

const isDocumentHidden = () => typeof document !== "undefined" && document.hidden;

/** Refusals that mean the job list on screen is out of date, so the store reloads it. */
const STALE_JOB_CODES = new Set(["JOB_ACTIVE", "JOB_NOT_ACTIVE", "JOB_NOT_RETRYABLE"]);

/** A new array, newest job first. */
const sortNewestFirst = (jobs: Iterable<TCodingJob>) =>
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy; the web app's TS lib (ES2022) has no toSorted
  [...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at));

/** The later of two copies of one job: the API bumps `updated_at` on every change. */
const fresher = (current: TCodingJob | undefined, incoming: TCodingJob) =>
  !current || incoming.updated_at >= current.updated_at ? incoming : current;

export interface ICodingJobStore {
  /** Project id → its coding settings, once loaded. */
  settingsMap: Record<string, TProjectCodingSettings>;
  /** Work item id → its jobs, newest first, once loaded. */
  jobsMap: Record<string, TCodingJob[]>;
  /** Job id → its events loaded so far, oldest first. */
  eventsMap: Record<string, TCodingJobEvent[]>;
  getSettings: (projectId: string | null | undefined) => TProjectCodingSettings | undefined;
  getJobs: (workItemId: string | null | undefined) => TCodingJob[] | undefined;
  getEvents: (jobId: string | null | undefined) => TCodingJobEvent[] | undefined;
  /** Loads the project's settings. Members and admins only: a guest's 403 is thrown. */
  fetchSettings: (workspaceSlug: string, projectId: string) => Promise<TProjectCodingSettings>;
  /** Project admins only. */
  updateSettings: (
    workspaceSlug: string,
    projectId: string,
    data: TProjectCodingSettingsUpdate
  ) => Promise<TProjectCodingSettings>;
  fetchJobs: (workspaceSlug: string, projectId: string, workItemId: string) => Promise<TCodingJob[]>;
  startJob: (
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    jobAction: TCodingAction,
    agent: TCodingAgent,
    /** One of the requester's approved machines; null (the default) is Auto. */
    machine?: string | null
  ) => Promise<TCodingJob>;
  cancelJob: (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => Promise<TCodingJob>;
  retryJob: (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => Promise<TCodingJob>;
  /** Loads the job's events after the last one loaded (all of them the first time). One request per job at a time. */
  fetchEvents: (
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    jobId: string
  ) => Promise<TCodingJobEvent[]>;
  /**
   * Reloads the work item's jobs every `CODING_JOB_POLL_MS` while one of them is active, until the returned function
   * is called. Ticks while the tab is hidden are skipped. Several watchers of one work item share one timer.
   */
  watchJobs: (workspaceSlug: string, projectId: string, workItemId: string) => () => void;
  /**
   * Loads the job's new events every `CODING_JOB_POLL_MS` while it is active (as the work item's loaded jobs show it),
   * and once more when it ends, until the returned function is called. Does not load them at first: call
   * `fetchEvents` for that.
   */
  watchEvents: (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => () => void;
}

/**
 * Coding jobs on work items and each project's coding settings. Every action throws the API's refusal as a
 * `CodingJobServiceError` for the caller to show; after a refusal that means the screen was out of date
 * (an active job already there, a job that already ended, coding switched off), the store reloads what it holds.
 */
export class CodingJobStore implements ICodingJobStore {
  settingsMap: Record<string, TProjectCodingSettings> = {};
  jobsMap: Record<string, TCodingJob[]> = {};
  eventsMap: Record<string, TCodingJobEvent[]> = {};

  private service: TCodingJobStoreService;
  // Bumped on every change this store makes to a work item's jobs, so a list request that was already in flight
  // merges into the newer list instead of replacing it.
  private jobsVersion: Record<string, number> = {};
  // The newest list request per work item: an older one that answers later is dropped.
  private jobsRequest: Record<string, number> = {};
  // One settings request per project at a time; bumped by every save so a read that started before it is dropped.
  private settingsInFlight: Record<string, Promise<TProjectCodingSettings>> = {};
  private settingsVersion: Record<string, number> = {};
  private eventsInFlight: Record<string, Promise<TCodingJobEvent[]>> = {};
  // Polling key → how many watchers share it and how to stop it.
  private watchers: Record<string, { count: number; stop: () => void }> = {};

  constructor(options: { service?: TCodingJobStoreService } = {}) {
    makeObservable<CodingJobStore, "upsertJob" | "setJobs" | "appendEvents">(this, {
      settingsMap: observable,
      jobsMap: observable,
      eventsMap: observable,
      fetchSettings: action,
      updateSettings: action,
      fetchJobs: action,
      startJob: action,
      cancelJob: action,
      retryJob: action,
      upsertJob: action,
      setJobs: action,
      appendEvents: action,
    });
    this.service = options.service ?? new CodingJobService();
  }

  getSettings = (projectId: string | null | undefined) => (projectId ? this.settingsMap[projectId] : undefined);

  getJobs = (workItemId: string | null | undefined) => (workItemId ? this.jobsMap[workItemId] : undefined);

  getEvents = (jobId: string | null | undefined) => (jobId ? this.eventsMap[jobId] : undefined);

  fetchSettings = (workspaceSlug: string, projectId: string) => {
    const inFlight = this.settingsInFlight[projectId];
    if (inFlight) return inFlight;
    const version = this.settingsVersion[projectId] ?? 0;
    const request = this.service
      .getSettings(workspaceSlug, projectId)
      .then((settings) => {
        if ((this.settingsVersion[projectId] ?? 0) !== version) return this.settingsMap[projectId] ?? settings;
        runInAction(() => {
          this.settingsMap[projectId] = settings;
        });
        return settings;
      })
      .finally(() => {
        if (this.settingsInFlight[projectId] === request) delete this.settingsInFlight[projectId];
      });
    this.settingsInFlight[projectId] = request;
    return request;
  };

  updateSettings = async (workspaceSlug: string, projectId: string, data: TProjectCodingSettingsUpdate) => {
    const settings = await this.service.updateSettings(workspaceSlug, projectId, data);
    this.settingsVersion[projectId] = (this.settingsVersion[projectId] ?? 0) + 1;
    runInAction(() => {
      this.settingsMap[projectId] = settings;
    });
    return settings;
  };

  fetchJobs = async (workspaceSlug: string, projectId: string, workItemId: string) => {
    const version = this.jobsVersion[workItemId] ?? 0;
    const requestId = (this.jobsRequest[workItemId] ?? 0) + 1;
    this.jobsRequest[workItemId] = requestId;
    const jobs = await this.service.list(workspaceSlug, projectId, workItemId);
    if (this.jobsRequest[workItemId] === requestId) {
      this.setJobs(workItemId, jobs, (this.jobsVersion[workItemId] ?? 0) !== version);
    }
    return this.jobsMap[workItemId] ?? [];
  };

  startJob = async (
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    jobAction: TCodingAction,
    agent: TCodingAgent,
    machine: string | null = null
  ) => {
    try {
      const job = await this.service.start(workspaceSlug, projectId, workItemId, { action: jobAction, agent, machine });
      this.upsertJob(workItemId, job);
      return job;
    } catch (error) {
      this.afterRefusal(error, workspaceSlug, projectId, workItemId);
      throw error;
    }
  };

  cancelJob = async (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => {
    try {
      const job = await this.service.cancel(workspaceSlug, projectId, workItemId, jobId);
      this.upsertJob(workItemId, job);
      return job;
    } catch (error) {
      this.afterRefusal(error, workspaceSlug, projectId, workItemId);
      throw error;
    }
  };

  retryJob = async (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => {
    try {
      const job = await this.service.retry(workspaceSlug, projectId, workItemId, jobId);
      this.upsertJob(workItemId, job);
      return job;
    } catch (error) {
      this.afterRefusal(error, workspaceSlug, projectId, workItemId);
      throw error;
    }
  };

  fetchEvents = (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => {
    const inFlight = this.eventsInFlight[jobId];
    if (inFlight) return inFlight;
    const request = this.loadNewEvents(workspaceSlug, projectId, workItemId, jobId).finally(() => {
      if (this.eventsInFlight[jobId] === request) delete this.eventsInFlight[jobId];
    });
    this.eventsInFlight[jobId] = request;
    return request;
  };

  watchJobs = (workspaceSlug: string, projectId: string, workItemId: string) =>
    this.watch(
      `jobs:${workItemId}`,
      () => (this.jobsMap[workItemId] ?? []).some(isCodingJobActive),
      () => this.fetchJobs(workspaceSlug, projectId, workItemId),
      false
    );

  watchEvents = (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) =>
    this.watch(
      `events:${jobId}`,
      () => !!this.jobsMap[workItemId]?.some((job) => job.id === jobId && isCodingJobActive(job)),
      () => this.fetchEvents(workspaceSlug, projectId, workItemId, jobId),
      true
    );

  private async loadNewEvents(workspaceSlug: string, projectId: string, workItemId: string, jobId: string) {
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const loaded = this.eventsMap[jobId];
      const after = loaded?.length ? loaded[loaded.length - 1].seq : undefined;
      // oxlint-disable-next-line no-await-in-loop -- each page starts after the last one, so they are sequential
      const { results, has_more } = await this.service.listEvents(workspaceSlug, projectId, workItemId, jobId, after);
      this.appendEvents(jobId, results);
      if (!has_more || results.length === 0) break;
    }
    return this.eventsMap[jobId] ?? [];
  }

  private appendEvents(jobId: string, events: TCodingJobEvent[]) {
    const loaded = this.eventsMap[jobId] ?? [];
    const last = loaded.length ? loaded[loaded.length - 1].seq : 0;
    this.eventsMap[jobId] = [...loaded, ...events.filter((event) => event.seq > last)];
  }

  /** Shares one poller per key between its watchers; the returned function releases this watcher (once). */
  private watch(key: string, isActive: () => boolean, reload: () => Promise<unknown>, reloadOnEnd: boolean) {
    const existing = this.watchers[key];
    if (existing) existing.count += 1;
    else this.watchers[key] = { count: 1, stop: this.poll(isActive, reload, reloadOnEnd) };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const watcher = this.watchers[key];
      if (!watcher) return;
      watcher.count -= 1;
      if (watcher.count > 0) return;
      watcher.stop();
      delete this.watchers[key];
    };
  }

  /**
   * Calls `reload` every `CODING_JOB_POLL_MS` while `isActive` (observed) is true, counting from the end of the last
   * reload; skips the call while the tab is hidden. With `reloadOnEnd`, reloads once more when it turns false.
   */
  private poll(isActive: () => boolean, reload: () => Promise<unknown>, reloadOnEnd: boolean) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), CODING_JOB_POLL_MS);
    };
    const tick = async () => {
      timer = undefined;
      if (!isDocumentHidden()) await this.reloadQuietly(reload);
      if (!stopped && isActive()) schedule();
    };
    const disposeReaction = reaction(
      isActive,
      (active, wasActive) => {
        if (active) {
          if (!timer) schedule();
          return;
        }
        clearTimeout(timer);
        timer = undefined;
        if (reloadOnEnd && wasActive) void this.reloadQuietly(reload);
      },
      { fireImmediately: true }
    );
    return () => {
      stopped = true;
      disposeReaction();
      clearTimeout(timer);
      timer = undefined;
    };
  }

  private setJobs(workItemId: string, jobs: TCodingJob[], merge: boolean) {
    if (!merge) {
      this.jobsMap[workItemId] = sortNewestFirst(jobs);
      return;
    }
    const byId = new Map((this.jobsMap[workItemId] ?? []).map((job) => [job.id, job]));
    for (const job of jobs) byId.set(job.id, fresher(byId.get(job.id), job));
    this.jobsMap[workItemId] = sortNewestFirst(byId.values());
  }

  private upsertJob(workItemId: string, job: TCodingJob) {
    this.jobsVersion[workItemId] = (this.jobsVersion[workItemId] ?? 0) + 1;
    const jobs = this.jobsMap[workItemId] ?? [];
    const current = jobs.find((existing) => existing.id === job.id);
    const others = jobs.filter((existing) => existing.id !== job.id);
    this.jobsMap[workItemId] = sortNewestFirst([...others, fresher(current, job)]);
  }

  /** Reloads what a refusal showed to be out of date. Failures here are ignored: the refusal is what matters. */
  private afterRefusal(error: unknown, workspaceSlug: string, projectId: string, workItemId: string) {
    if (!(error instanceof CodingJobServiceError)) return;
    if (error.code && STALE_JOB_CODES.has(error.code))
      void this.reloadQuietly(() => this.fetchJobs(workspaceSlug, projectId, workItemId));
    if (error.code === "CODING_NOT_CONFIGURED")
      void this.reloadQuietly(() => this.fetchSettings(workspaceSlug, projectId));
  }

  private async reloadQuietly(reload: () => Promise<unknown>) {
    try {
      await reload();
    } catch {
      // The refusal already reached the caller.
    }
  }
}
