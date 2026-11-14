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
   * The workspace, if the user is an active member of it (`GET /api/workspaces/<slug>/chat/me/`, read for its
   * `workspace_id`). Anyone else gets a 403 from the API, which surfaces as a `PlaneApiError`.
   */
  workspace(cookie: string, slug: string, signal?: AbortSignal): Promise<{ id: string }>;
  /**
   * Every channel the user can see in the workspace, live or archived, and whether they are in it
   * (`GET chat/channels/access/`). An API too old to have that route answers it with a 404; then the full channel
   * lists are read instead (`GET chat/channels/`, live and `?archived=true`), which say the same at a higher cost.
   */
  channelAccess(cookie: string, slug: string, signal?: AbortSignal): Promise<ChannelAccess[]>;
  /** One channel, if the user can see it (`GET chat/channels/<id>/`). A channel they can't see is a 404. */
  channel(cookie: string, slug: string, channelId: string, signal?: AbortSignal): Promise<ChannelAccess>;
}

/** What the gateway needs to know about a channel: that the user may see it, and whether they are in it. */
export interface ChannelAccess {
  readonly id: string;
  readonly is_member: boolean;
}

const userSchema = z.object({ id: z.string().min(1) });
const chatMeSchema = z.object({ workspace_id: z.string().min(1) });
const channelSchema = z.object({ id: z.string().min(1), is_member: z.boolean() });

export interface PlaneApiOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Most calls under way at once; the rest wait their turn. Default: no limit. */
  readonly maxConcurrent?: number;
  /** After `chat/channels/access/` answers 404, how long to use the channel lists before trying it again. */
  readonly accessRetryMs?: number;
}

/** At most `limit` holders at once. A waiter whose signal aborts gives up its place. */
class Limiter {
  readonly #limit: number;
  readonly #waiting = new Set<() => void>();
  #active = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onTurn = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.#waiting.delete(onTurn);
        reject(signal?.reason as Error);
      };
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      this.#waiting.add(onTurn);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Hand the slot to whoever has waited longest, or give it back. */
  release(): void {
    const next = this.#waiting.values().next().value;
    if (next) {
      this.#waiting.delete(next);
      next();
    } else {
      this.#active -= 1;
    }
  }
}

export function createPlaneApi(options: PlaneApiOptions): PlaneApi {
  const base = trimTrailingSlashes(options.baseUrl);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const limiter = new Limiter(options.maxConcurrent ?? Number.POSITIVE_INFINITY);
  const accessRetryMs = options.accessRetryMs ?? 5 * 60_000;
  /** Until when `chat/channels/access/` is taken to be missing from the API (a gateway deployed ahead of it). */
  let accessMissingUntil = 0;

  /** GET `path` as the user and parse the JSON body with `schema`, once there is room to. */
  const get = async <T>(path: string, cookie: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
    try {
      await limiter.acquire(signal);
    } catch (error) {
      throw new PlaneApiError(`Plane API request failed: ${(error as Error).message}`, 0);
    }
    try {
      return await request(path, cookie, schema, signal);
    } finally {
      limiter.release();
    }
  };

  const request = async <T>(path: string, cookie: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
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
    if (!response.ok) {
      // Left unread, a body too large to buffer keeps its connection out of the pool.
      await response.body?.cancel().catch(() => undefined);
      throw new PlaneApiError(`${path} answered ${response.status}`, response.status);
    }
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
    workspace: async (cookie, slug, signal) => {
      const me = await get(`/api/workspaces/${encodeURIComponent(slug)}/chat/me/`, cookie, chatMeSchema, signal);
      return { id: me.workspace_id };
    },
    channelAccess: async (cookie, slug, signal) => {
      const channels = `/api/workspaces/${encodeURIComponent(slug)}/chat/channels/`;
      if (Date.now() >= accessMissingUntil) {
        try {
          return await get(`${channels}access/`, cookie, z.array(channelSchema), signal);
        } catch (error) {
          if (!(error instanceof PlaneApiError && error.status === 404)) throw error;
          // Should the route be there and answer 404 for another reason, the lists below answer it the same way.
          accessMissingUntil = Date.now() + accessRetryMs;
        }
      }
      const [live, archived] = await Promise.all([
        get(`${channels}?archived=false`, cookie, z.array(channelSchema), signal),
        get(`${channels}?archived=true`, cookie, z.array(channelSchema), signal),
      ]);
      return [...live, ...archived];
    },
    channel: (cookie, slug, channelId, signal) =>
      get(
        `/api/workspaces/${encodeURIComponent(slug)}/chat/channels/${encodeURIComponent(channelId)}/`,
        cookie,
        channelSchema,
        signal
      ),
  };
}
