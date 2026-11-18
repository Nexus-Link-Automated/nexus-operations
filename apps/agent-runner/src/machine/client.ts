/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { JobChanges } from "./changes.ts";
import type { About, Capabilities } from "./report.ts";
import { MACHINE_VERSION } from "./version.ts";

/**
 * The CRM's machine endpoints (`apps/api/plane/coding/README.md`, "Machines"). Requests go
 * through Node's built-in fetch, whose shared dispatcher keeps the HTTPS connection alive between
 * heartbeats, so the machine holds one outbound connection and opens no port.
 */

export const JOIN_PATH = "/api/v1/coding-machines/join/";
export const HEARTBEAT_PATH = "/api/v1/coding-machines/heartbeat/";
export const EVENTS_PATH = "/api/v1/coding-machines/jobs/events/";
export const A2A_PATH = "/api/v1/coding-machines/a2a/";
export const resultPath = (jobId: string) => `/api/v1/coding-machines/jobs/${encodeURIComponent(jobId)}/result/`;

/** A request that has not answered after this long is given up and retried. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface JoinAnswer {
  readonly machineId: string;
  readonly key: string;
  readonly name: string;
  readonly workspaceSlug: string;
  readonly state: string;
  readonly heartbeatSeconds: number;
}

export interface HeartbeatAnswer {
  readonly machineId: string;
  readonly name: string;
  readonly state: string;
  readonly heartbeatSeconds: number;
  /** New jobs (and jobs offered again because the machine has not confirmed them yet), unparsed. */
  readonly jobs: readonly unknown[];
  /** Jobs the machine said it runs that the CRM has ended or never gave it: stop them. */
  readonly cancel: readonly string[];
}

export interface HeartbeatBody extends About {
  readonly capabilities?: Capabilities;
  /** The jobs running now. Sent on every heartbeat; a machine that leaves it out gets no jobs. */
  readonly running?: readonly string[];
}

export type EventKind = "status" | "message" | "tool" | "plan";

export interface JobEvent {
  readonly kind: EventKind;
  readonly text: string;
}

export interface JobEventBatch {
  readonly id: string;
  readonly events: readonly JobEvent[];
}

export interface EventsAnswer {
  /** Jobs that are no longer running on this machine: stop them. */
  readonly ended: readonly string[];
}

/** What the machine sends when a job ends: its result, and the files it changed for the pull request. */
export interface ResultBody {
  readonly result: Record<string, unknown>;
  readonly changes?: JobChanges;
  /** Why changed files are not sent (too large, ...): the CRM says it on the work item. */
  readonly changes_note?: string;
}

export interface ResultAnswer {
  readonly status: string;
  readonly outcome: string | null;
  readonly changed: boolean;
}

/** What came back: a parsed answer, a refusal with the CRM's error `code`, or no answer at all. */
export type CrmResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly code?: string;
      readonly retryAfterMs?: number;
      readonly errors?: unknown;
    }
  | { readonly kind: "network"; readonly error: string };

export type FetchLike = typeof fetch;

export interface CrmClientOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** `Retry-After` in seconds (all DRF sends) → ms. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class CrmClient {
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, options: CrmClientOptions = {}) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async join(code: string, about: About, signal?: AbortSignal): Promise<CrmResult<JoinAnswer>> {
    const result = await this.#post(JOIN_PATH, { code, ...about }, undefined, signal);
    if (result.kind !== "ok") return result;
    const body = result.value;
    const machineId = body.machine_id;
    const key = body.key;
    if (typeof machineId !== "string" || typeof key !== "string" || !key) {
      return { kind: "network", error: "The CRM's answer to the join has no machine key." };
    }
    return {
      kind: "ok",
      value: {
        machineId,
        key,
        name: typeof body.name === "string" ? body.name : "",
        workspaceSlug: typeof body.workspace_slug === "string" ? body.workspace_slug : "",
        state: typeof body.state === "string" ? body.state : "",
        heartbeatSeconds: typeof body.heartbeat_seconds === "number" ? body.heartbeat_seconds : 0,
      },
    };
  }

  async heartbeat(key: string, body: HeartbeatBody, signal?: AbortSignal): Promise<CrmResult<HeartbeatAnswer>> {
    const result = await this.#post(HEARTBEAT_PATH, body, key, signal);
    if (result.kind !== "ok") return result;
    const answer = result.value;
    return {
      kind: "ok",
      value: {
        machineId: typeof answer.machine_id === "string" ? answer.machine_id : "",
        name: typeof answer.name === "string" ? answer.name : "",
        state: typeof answer.state === "string" ? answer.state : "",
        heartbeatSeconds: typeof answer.heartbeat_seconds === "number" ? answer.heartbeat_seconds : 0,
        jobs: Array.isArray(answer.jobs) ? answer.jobs : [],
        cancel: strings(answer.cancel),
      },
    };
  }

  async events(key: string, jobs: readonly JobEventBatch[], signal?: AbortSignal): Promise<CrmResult<EventsAnswer>> {
    const result = await this.#post(EVENTS_PATH, { jobs }, key, signal);
    if (result.kind !== "ok") return result;
    return { kind: "ok", value: { ended: strings(result.value.ended) } };
  }

  async result(key: string, jobId: string, body: ResultBody, signal?: AbortSignal): Promise<CrmResult<ResultAnswer>> {
    const result = await this.#post(resultPath(jobId), body, key, signal);
    if (result.kind !== "ok") return result;
    const answer = result.value;
    return {
      kind: "ok",
      value: {
        status: typeof answer.status === "string" ? answer.status : "",
        outcome: typeof answer.outcome === "string" ? answer.outcome : null,
        changed: answer.changed === true,
      },
    };
  }

  /** One A2A JSON-RPC request to the CRM agent (`apps/api/plane/coding/a2a.py`); the answer is the JSON-RPC response. */
  async a2a(
    key: string,
    request: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CrmResult<Record<string, unknown>>> {
    return this.#post(A2A_PATH, request, key, signal);
  }

  async #post(
    pathname: string,
    body: unknown,
    key: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<CrmResult<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#base}${pathname}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `nexus-machine/${MACHINE_VERSION}`,
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        // A redirect is never expected; following one could carry the key somewhere else.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      text = await response.text();
    } catch (error) {
      const cause = (error as { cause?: { code?: unknown } }).cause;
      const detail = typeof cause?.code === "string" ? cause.code : (error as Error).name;
      return { kind: "network", error: detail || "request failed" };
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    const record = isRecord(parsed) ? parsed : {};
    if (response.ok) {
      if (!isRecord(parsed)) return { kind: "http", status: response.status, code: "NOT_JSON" };
      return { kind: "ok", value: record };
    }
    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    return {
      kind: "http",
      status: response.status,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      ...(record.errors === undefined ? {} : { errors: record.errors }),
    };
  }
}
