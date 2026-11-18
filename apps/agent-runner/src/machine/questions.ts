/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- one request at a time while waiting for an answer, on purpose */
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import type { CrmResult } from "./client.ts";

/**
 * Asking the CRM agent a question for a job, over A2A (`apps/api/plane/coding/a2a.py`): the job is
 * the A2A task; the question goes with `message/send`, and the answer is read back with
 * `tasks/get` (machines only connect out, so nothing is pushed to them). The answer message's
 * `metadata.prompt` is what the agent gets next, written by the CRM.
 */

export interface A2AClient {
  a2a(key: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<CrmResult<Record<string, unknown>>>;
}

export type Ask = (jobId: string, question: string, signal: AbortSignal) => Promise<string | undefined>;

const POLL_MS = 5_000;
const RETRY_MS = 15_000;
/** The longest a job waits for an answer, whatever the CRM says. */
const MAX_WAIT_MS = 2 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENDED = new Set(["completed", "failed", "canceled", "rejected"]);

/** What the agent hears when its question could not be asked. */
export function notAsked(reason: string): string {
  return (
    `Your question could not be asked (${reason.slice(0, 300)}). Go on without an answer if you can; otherwise ` +
    'report a "job_error" saying what you needed.'
  );
}

export function a2aAsker(
  client: A2AClient,
  key: string,
  options: {
    pollMs?: number;
    retryMs?: number;
    maxWaitMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {}
): Ask {
  const sleep = options.sleep ?? ((ms, signal) => wait(ms, undefined, { signal }).catch(() => undefined));
  let requestId = 0;
  const call = async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
    // Retries while the CRM cannot be reached (at most an hour); a JSON-RPC answer (result or error) ends it.
    const until = Date.now() + 60 * 60_000;
    while (!signal.aborted && Date.now() < until) {
      const answer = await client.a2a(key, { jsonrpc: "2.0", id: ++requestId, method, params }, signal);
      if (answer.kind === "ok") return answer.value;
      if (answer.kind === "http" && answer.status !== 429 && answer.status < 500) {
        return { error: { message: `the CRM answered ${answer.status}` } };
      }
      await sleep(
        answer.kind === "http" && answer.retryAfterMs ? answer.retryAfterMs : (options.retryMs ?? RETRY_MS),
        signal
      );
    }
    return undefined;
  };

  return async (jobId, question, signal) => {
    const messageId = randomUUID();
    const sent = await call(
      "message/send",
      {
        message: {
          kind: "message",
          role: "user",
          messageId,
          taskId: jobId,
          parts: [{ kind: "text", text: question }],
        },
      },
      signal
    );
    if (!sent) return undefined;
    if (isRecord(sent.error)) return notAsked(String(sent.error.message ?? "the CRM refused it"));
    const giveUpAt = Date.now() + (options.maxWaitMs ?? MAX_WAIT_MS);
    while (!signal.aborted) {
      await sleep(options.pollMs ?? POLL_MS, signal);
      if (signal.aborted) break;
      // The CRM ends an unanswered question itself (30 minutes); this is only a backstop.
      if (Date.now() > giveUpAt) return notAsked("no answer came");
      const got = await call("tasks/get", { id: jobId }, signal);
      if (got && isRecord(got.error)) return notAsked(String(got.error.message ?? "the CRM could not say"));
      const task = got && isRecord(got.result) ? got.result : undefined;
      if (!task) continue;
      const history = Array.isArray(task.history) ? task.history : [];
      for (const message of history) {
        if (!isRecord(message) || message.role !== "agent" || !isRecord(message.metadata)) continue;
        if (message.metadata.question_message_id !== messageId) continue;
        const prompt = message.metadata.prompt;
        return typeof prompt === "string" && prompt.trim() ? prompt : notAsked("the answer was empty");
      }
      const state = isRecord(task.status) ? task.status.state : undefined;
      // The job ended meanwhile: the CRM stops it; no next turn.
      if (typeof state === "string" && ENDED.has(state)) return undefined;
    }
    return undefined;
  };
}
