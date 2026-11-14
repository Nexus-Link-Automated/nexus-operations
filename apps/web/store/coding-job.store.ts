/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, runInAction } from "mobx";
import { CodingJobService, CodingJobServiceError } from "@plane/services";
import type {
  TCodingAction,
  TCodingAgent,
  TCodingJob,
  TProjectCodingSettings,
  TProjectCodingSettingsUpdate,
} from "@plane/types";

/** The REST calls the store makes. `CodingJobService` in the app; a fake in tests. */
export type TCodingJobStoreService = Pick<
  CodingJobService,
  "list" | "start" | "cancel" | "retry" | "getSettings" | "updateSettings"
>;

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
  getSettings: (projectId: string | null | undefined) => TProjectCodingSettings | undefined;
  getJobs: (workItemId: string | null | undefined) => TCodingJob[] | undefined;
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
    agent: TCodingAgent
  ) => Promise<TCodingJob>;
  cancelJob: (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => Promise<TCodingJob>;
  retryJob: (workspaceSlug: string, projectId: string, workItemId: string, jobId: string) => Promise<TCodingJob>;
}

/**
 * Coding jobs on work items and each project's coding settings. Every action throws the API's refusal as a
 * `CodingJobServiceError` for the caller to show; after a refusal that means the screen was out of date
 * (an active job already there, a job that already ended, coding switched off), the store reloads what it holds.
 */
export class CodingJobStore implements ICodingJobStore {
  settingsMap: Record<string, TProjectCodingSettings> = {};
  jobsMap: Record<string, TCodingJob[]> = {};

  private service: TCodingJobStoreService;
  // Bumped on every change this store makes to a work item's jobs, so a list request that was already in flight
  // merges into the newer list instead of replacing it.
  private jobsVersion: Record<string, number> = {};

  constructor(options: { service?: TCodingJobStoreService } = {}) {
    makeObservable<CodingJobStore, "upsertJob" | "setJobs">(this, {
      settingsMap: observable,
      jobsMap: observable,
      fetchSettings: action,
      updateSettings: action,
      fetchJobs: action,
      startJob: action,
      cancelJob: action,
      retryJob: action,
      upsertJob: action,
      setJobs: action,
    });
    this.service = options.service ?? new CodingJobService();
  }

  getSettings = (projectId: string | null | undefined) => (projectId ? this.settingsMap[projectId] : undefined);

  getJobs = (workItemId: string | null | undefined) => (workItemId ? this.jobsMap[workItemId] : undefined);

  fetchSettings = async (workspaceSlug: string, projectId: string) => {
    const settings = await this.service.getSettings(workspaceSlug, projectId);
    runInAction(() => {
      this.settingsMap[projectId] = settings;
    });
    return settings;
  };

  updateSettings = async (workspaceSlug: string, projectId: string, data: TProjectCodingSettingsUpdate) => {
    const settings = await this.service.updateSettings(workspaceSlug, projectId, data);
    runInAction(() => {
      this.settingsMap[projectId] = settings;
    });
    return settings;
  };

  fetchJobs = async (workspaceSlug: string, projectId: string, workItemId: string) => {
    const version = this.jobsVersion[workItemId] ?? 0;
    const jobs = await this.service.list(workspaceSlug, projectId, workItemId);
    this.setJobs(workItemId, jobs, (this.jobsVersion[workItemId] ?? 0) !== version);
    return this.jobsMap[workItemId] ?? [];
  };

  startJob = async (
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    jobAction: TCodingAction,
    agent: TCodingAgent
  ) => {
    try {
      const job = await this.service.start(workspaceSlug, projectId, workItemId, { action: jobAction, agent });
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
