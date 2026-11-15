/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- the heartbeat loop sends one request at a time on purpose */
import { setTimeout as wait } from "node:timers/promises";

import type { Logger } from "../logger.ts";
import type { CrmResult, HeartbeatAnswer, HeartbeatBody } from "./client.ts";
import type { MachineConfig } from "./config.ts";
import type { About, Capabilities } from "./report.ts";

/**
 * The machine service's loop: one heartbeat at a time, every `heartbeat_seconds` the CRM asks
 * for, with the latest capabilities report. It never runs jobs yet (Step 4 adds them); jobs stay
 * queued on the CRM.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 64;
/** EX_CONFIG: the key will never work again (or there is none). systemd does not restart on it. */
export const EXIT_CONFIG = 78;

export interface Backoff {
  /** First retry delay. */
  readonly baseMs: number;
  /** The cap, and the delay used while the owner is not allowed (403). */
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { baseMs: 1_000, maxMs: 60_000 };
/** Detection starts a process per tool, so it runs every few minutes, not on every heartbeat. */
export const DEFAULT_REDETECT_MS = 5 * 60_000;
/** Bounds on the CRM's `heartbeat_seconds`, so a bad answer can neither hammer it nor go silent. */
const MIN_HEARTBEAT_MS = 5_000;
const MAX_HEARTBEAT_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or as soon as `signal` aborts. */
export const defaultSleep: Sleep = (ms, signal) => wait(ms, undefined, { signal }).catch(() => undefined);

export interface HeartbeatClient {
  heartbeat(key: string, body: HeartbeatBody, signal?: AbortSignal): Promise<CrmResult<HeartbeatAnswer>>;
}

export interface RunOptions {
  readonly config: MachineConfig;
  readonly client: HeartbeatClient;
  readonly about: About;
  readonly detect: () => Promise<Capabilities>;
  readonly log: Logger;
  /** Aborted on SIGTERM/SIGINT: the loop stops and resolves with 0. */
  readonly signal: AbortSignal;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly backoff?: Backoff;
  readonly redetectMs?: number;
}

/** `ms` with jitter: somewhere in [ms/2, ms], so machines that lost the CRM together do not return together. */
export function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
}

/** The delay before retry number `failures` (1-based): base, doubling, capped. Before jitter. */
export function backoffDelay(failures: number, backoff: Backoff): number {
  return Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, failures - 1));
}

/** The CRM's codes for a key that will never work again. */
export const KEY_REFUSED_FOR_GOOD: ReadonlySet<string> = new Set([
  "MACHINE_KEY_INVALID",
  "MACHINE_UNKNOWN",
  "MACHINE_REVOKED",
]);

const STATE_MESSAGES: Record<string, string> = {
  awaiting_approval: "machine-service: joined; waiting for the owner to approve this machine in the CRM",
  active: "machine-service: approved and online; jobs will arrive once dispatch is enabled",
};

/** Runs until `signal` aborts (→ 0) or the CRM says the key will never work (→ 78). */
export async function runMachine(options: RunOptions): Promise<number> {
  const { config, client, about, log, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const redetectMs = options.redetectMs ?? DEFAULT_REDETECT_MS;

  let capabilities: Capabilities | undefined;
  let detectedAt = 0;
  // Set when the CRM refused the report (400): heartbeats go without it until the next detection.
  let reportRefused = false;
  let failures = 0;
  let lastState: string | undefined;
  let lastProblem: string | undefined;

  log.info("machine-service: starting", { machine: config.name, workspace: config.workspaceSlug, crm: config.url });
  while (!signal.aborted) {
    if (capabilities === undefined || now() - detectedAt >= redetectMs) {
      capabilities = await options.detect().catch(() => capabilities);
      detectedAt = now();
      reportRefused = false;
      if (signal.aborted) break;
    }
    const body: HeartbeatBody = capabilities && !reportRefused ? { ...about, capabilities } : { ...about };
    const result = await client.heartbeat(config.key, body, signal);
    if (signal.aborted) break;

    let delay: number;
    if (result.kind === "ok") {
      if (failures > 0) log.info("machine-service: connected again", { after: failures });
      failures = 0;
      lastProblem = undefined;
      const { state } = result.value;
      if (state !== lastState) {
        log.info(STATE_MESSAGES[state] ?? "machine-service: state changed", { state });
        lastState = state;
      }
      const seconds = result.value.heartbeatSeconds;
      delay =
        seconds > 0 ? Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, seconds * 1000)) : DEFAULT_HEARTBEAT_MS;
    } else if (result.kind === "http" && result.status === 401 && KEY_REFUSED_FOR_GOOD.has(result.code ?? "")) {
      // Retrying can never help. A 401 without one of these codes (a proxy or sign-in gateway in front of the
      // CRM, say) is retried slowly below instead.
      log.error("machine-service: the CRM refused this machine's key for good; join again with a new code", {
        status: 401,
        code: result.code ?? null,
      });
      return EXIT_CONFIG;
    } else {
      failures += 1;
      const problem = describe(result);
      // Each retry is logged at debug; a new kind of problem is logged once.
      if (problem !== lastProblem) {
        log.warn(`machine-service: ${problem}; retrying`, { attempt: failures });
        lastProblem = problem;
      } else {
        log.debug(`machine-service: ${problem}; retrying`, { attempt: failures });
      }
      if (result.kind === "http" && result.status === 403) {
        // MACHINE_OWNER_NOT_ALLOWED: it may change (the owner is let back in), so keep asking, slowly.
        delay = jitter(backoff.maxMs, random);
      } else if (result.kind === "http" && result.status === 429) {
        const wanted = Math.min(backoff.maxMs, result.retryAfterMs ?? 0);
        delay = Math.max(jitter(backoffDelay(failures, backoff), random), wanted);
      } else if (result.kind === "http" && result.status === 400) {
        // Our report did not pass the CRM's schema (a newer CRM?). Stay online without it.
        log.warn("machine-service: the CRM refused the capabilities report; sending heartbeats without it", {
          errors: result.errors ?? null,
        });
        reportRefused = true;
        delay = jitter(backoffDelay(failures, backoff), random);
      } else if (result.kind === "network" || result.status >= 500) {
        delay = jitter(backoffDelay(failures, backoff), random);
      } else {
        // Anything else (404 from a wrong URL, an HTML page): not going to fix itself quickly.
        delay = jitter(backoff.maxMs, random);
      }
    }
    await sleep(delay, signal);
  }
  log.info("machine-service: stopped");
  return EXIT_OK;
}

function describe(result: Exclude<CrmResult<unknown>, { kind: "ok" }>): string {
  if (result.kind === "network") return `cannot reach the CRM (${result.error})`;
  if (result.status === 403) return `the CRM refused this machine for now (403${result.code ? ` ${result.code}` : ""})`;
  if (result.status === 429) return "the CRM asked to slow down (429)";
  if (result.status >= 500) return `the CRM had an error (${result.status})`;
  return `unexpected answer from the CRM (${result.status}${result.code ? ` ${result.code}` : ""})`;
}
