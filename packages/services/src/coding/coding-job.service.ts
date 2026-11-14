/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type {
  TCodingAction,
  TCodingAgent,
  TCodingErrorCode,
  TCodingJob,
  TProjectCodingSettings,
  TProjectCodingSettingsUpdate,
} from "@plane/types";
import { APIService } from "../api.service";

/** A refused or failed coding request. `code` is the API's refusal code when it sent one. */
export class CodingJobServiceError extends Error {
  readonly status: number;
  readonly code: TCodingErrorCode | string | null;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    const body = (data as { error?: unknown; detail?: unknown; code?: unknown } | undefined) ?? {};
    const message = typeof body.error === "string" ? body.error : typeof body.detail === "string" ? body.detail : "";
    super(message || `Coding job request failed (${status || "network error"})`);
    this.name = "CodingJobServiceError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : null;
    this.data = data;
  }

  /** Field errors from a 400 `{"errors": {field: [messages]}}`. */
  get fieldErrors(): Record<string, string[]> {
    const errors = (this.data as { errors?: unknown } | undefined)?.errors;
    return errors && typeof errors === "object" ? (errors as Record<string, string[]>) : {};
  }
}

function toCodingError(error: unknown): CodingJobServiceError {
  const response = (error as { response?: { status?: number; data?: unknown } } | undefined)?.response;
  return new CodingJobServiceError(response?.status ?? 0, response?.data);
}

type TPaginated<T> = { results: T[]; next_cursor?: string; next_page_results?: boolean };

/**
 * Coding jobs on work items and each project's coding settings, through the web app's session routes
 * (the same paths as `/api/v1/`). Every failure is thrown as a `CodingJobServiceError`.
 */
export class CodingJobService extends APIService {
  constructor(BASE_URL?: string) {
    super(BASE_URL || API_BASE_URL);
  }

  private projectPath(workspaceSlug: string, projectId: string) {
    return `/api/workspaces/${workspaceSlug}/projects/${projectId}`;
  }

  private jobsPath(workspaceSlug: string, projectId: string, workItemId: string) {
    return `${this.projectPath(workspaceSlug, projectId)}/work-items/${workItemId}/coding-jobs/`;
  }

  /** The work item's jobs, newest first (the newest 50). */
  async list(workspaceSlug: string, projectId: string, workItemId: string): Promise<TCodingJob[]> {
    return this.get(this.jobsPath(workspaceSlug, projectId, workItemId))
      .then((response) => (response?.data as TPaginated<TCodingJob>)?.results ?? [])
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  async start(
    workspaceSlug: string,
    projectId: string,
    workItemId: string,
    data: { action: TCodingAction; agent: TCodingAgent }
  ): Promise<TCodingJob> {
    return this.post(this.jobsPath(workspaceSlug, projectId, workItemId), data)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  async cancel(workspaceSlug: string, projectId: string, workItemId: string, jobId: string): Promise<TCodingJob> {
    return this.post(`${this.jobsPath(workspaceSlug, projectId, workItemId)}${jobId}/cancel/`, {})
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Starts a new job like this one; the API answers with the new job. */
  async retry(workspaceSlug: string, projectId: string, workItemId: string, jobId: string): Promise<TCodingJob> {
    return this.post(`${this.jobsPath(workspaceSlug, projectId, workItemId)}${jobId}/retry/`, {})
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Members and admins only; guests get 403. */
  async getSettings(workspaceSlug: string, projectId: string): Promise<TProjectCodingSettings> {
    return this.get(`${this.projectPath(workspaceSlug, projectId)}/coding-settings/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }

  /** Project admins only. Changes only the fields sent; a state field set to null matches by name. */
  async updateSettings(
    workspaceSlug: string,
    projectId: string,
    data: TProjectCodingSettingsUpdate
  ): Promise<TProjectCodingSettings> {
    return this.patch(`${this.projectPath(workspaceSlug, projectId)}/coding-settings/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw toCodingError(error);
      });
  }
}
