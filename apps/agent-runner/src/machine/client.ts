/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { About, Capabilities } from "./report.ts";
import { MACHINE_VERSION } from "./version.ts";

/**
 * The CRM's machine endpoints (`apps/api/plane/coding/README.md`, "Machines"). Requests go
 * through Node's built-in fetch, whose shared dispatcher keeps the HTTPS connection alive between
 * heartbeats, so the machine holds one outbound connection and opens no port.
 */

export const JOIN_PATH = "/api/v1/coding-machines/join/";
export const HEARTBEAT_PATH = "/api/v1/coding-machines/heartbeat/";

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
  readonly jobs: readonly unknown[];
}

export interface HeartbeatBody extends About {
  readonly capabilities?: Capabilities;
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
      },
    };
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
