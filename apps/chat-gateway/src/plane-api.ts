/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { z } from "zod";

import { trimTrailingSlashes } from "./origin.ts";

/** A non-2xx answer (or no answer) from the Plane API. `status` is 0 for network failures. */
export class PlaneApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlaneApiError";
    this.status = status;
  }

  /** The API does not know this cookie: signed out, expired, or never valid. */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * What the gateway reads from the Plane API. Every call carries the user's own session cookie, so
 * Django decides, as it does for the web app, and the gateway needs no credentials of its own.
 */
export interface PlaneApi {
  /** The signed-in user behind a browser cookie (`GET /api/users/me/`). */
  currentUser(cookie: string, signal?: AbortSignal): Promise<{ id: string }>;
  /**
   * The workspace, if the user is an active member of it (`GET /api/workspaces/<slug>/`). Anyone else
   * gets a 404 (or a 403) from the API, which surfaces as a `PlaneApiError`.
   */
  workspace(cookie: string, slug: string, signal?: AbortSignal): Promise<{ id: string }>;
}

const userSchema = z.object({ id: z.string().min(1) });
const workspaceSchema = z.object({ id: z.string().min(1) });

export interface PlaneApiOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export function createPlaneApi(options: PlaneApiOptions): PlaneApi {
  const base = trimTrailingSlashes(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  /** GET `path` as the user and parse the JSON body with `schema`. */
  const get = async <T>(path: string, cookie: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "GET",
        headers: { Cookie: cookie, Accept: "application/json" },
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new PlaneApiError(`Plane API request failed: ${(error as Error).message}`, 0);
    }
    if (!response.ok) throw new PlaneApiError(`${path} answered ${response.status}`, response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PlaneApiError(`${path}: response is not JSON`, response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PlaneApiError(`${path}: unexpected response`, 502);
    return parsed.data;
  };

  return {
    currentUser: (cookie, signal) => get("/api/users/me/", cookie, userSchema, signal),
    workspace: (cookie, slug, signal) =>
      get(`/api/workspaces/${encodeURIComponent(slug)}/`, cookie, workspaceSchema, signal),
  };
}
