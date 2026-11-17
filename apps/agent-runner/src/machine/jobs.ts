/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- results and event batches are sent one request at a time on purpose */
import { setTimeout as wait } from "node:timers/promises";

import type { Logger } from "../logger.ts";
import type { CrmResult, EventsAnswer, JobEvent, JobEventBatch, ResultAnswer, ResultBody } from "./client.ts";
import { jobError, type JobEnd } from "./job.ts";
import { parseOrder, type JobOrder } from "./orders.ts";

type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) => wait(ms, undefined, { signal }).catch(() => undefined);

/**
 * The jobs this machine runs: at most `slots` at once. It takes new ones from heartbeat answers,
 * stops the ones the CRM ends, sends their progress lines in batches, and delivers each result.
 * A job stays in `running` (and so in every heartbeat) until its result is delivered, so the CRM
 * never takes a job whose result is still on its way for one the machine dropped.
 */

export interface JobsClient {
  events(key: string, jobs: readonly JobEventBatch[], signal?: AbortSignal): Promise<CrmResult<EventsAnswer>>;
  result(key: string, jobId: string, body: ResultBody, signal?: AbortSignal): Promise<CrmResult<ResultAnswer>>;
}

export type JobRunner = (order: JobOrder, emit: (event: JobEvent) => void, stop: AbortSignal) => Promise<JobEnd>;

export interface JobManagerOptions {
  readonly key: string;
  readonly slots: number;
  readonly client: JobsClient;
  readonly run: JobRunner;
  readonly log: Logger;
  /** Whether jobs can start now (the job image is ready). */
  readonly canRun?: () => boolean;
  readonly sleep?: Sleep;
  /** How often buffered progress lines are sent. */
  readonly flushMs?: number;
  /** Attempts and spacing for delivering a result. */
  readonly resultAttempts?: number;
  readonly resultRetryMs?: number;
  /** Called when a job's folder may be cleaned up (after each job). */
  readonly onJobDone?: (running: ReadonlySet<string>) => void;
}

/** Progress lines kept per job while the CRM cannot be reached. */
const MAX_BUFFERED = 500;
const BATCH_PER_JOB = 50;
const DEFAULT_FLUSH_MS = 3_000;
const DEFAULT_RESULT_ATTEMPTS = 40;
const DEFAULT_RESULT_RETRY_MS = 15_000;

interface Running {
  readonly order: JobOrder | undefined;
  readonly stop: AbortController;
  readonly buffer: JobEvent[];
  dropped: number;
  done: Promise<void>;
}

export class JobManager {
  readonly #options: JobManagerOptions;
  readonly #jobs = new Map<string, Running>();
  readonly #sleep: Sleep;
  #flushing = false;
  #stopping = false;

  constructor(options: JobManagerOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** The jobs to list in the heartbeat. */
  get runningIds(): string[] {
    return [...this.#jobs.keys()];
  }

  get free(): number {
    return Math.max(0, this.#options.slots - this.#jobs.size);
  }

  /** Takes the jobs from a heartbeat answer. One it already runs (offered again) is ignored. */
  accept(rawJobs: readonly unknown[]): void {
    for (const raw of rawJobs) {
      const parsed = parseOrder(raw);
      if (!parsed.ok) {
        this.#options.log.warn("machine-service: refused a job from the CRM", { error: parsed.error });
        if (parsed.id && !this.#jobs.has(parsed.id)) {
          const result = jobError(`The machine could not read the job: ${parsed.error}.`);
          this.#track(parsed.id, undefined, async () => ({ kind: "result" as const, result }));
        }
        continue;
      }
      const { order } = parsed;
      if (this.#jobs.has(order.id)) continue;
      if (this.free <= 0 || (this.#options.canRun && !this.#options.canRun())) {
        // Not listed in the next heartbeat, so the CRM offers it again or ends it.
        this.#options.log.warn("machine-service: no free slot for a job; leaving it to the CRM", { job: order.id });
        continue;
      }
      this.#options.log.info("machine-service: job started", {
        job: order.id,
        action: order.action,
        agent: order.agent,
      });
      const stop = new AbortController();
      const emit = (event: JobEvent) => this.#buffer(order.id, event);
      this.#track(order.id, order, () => this.#options.run(order, emit, stop.signal), stop);
    }
  }

  /** Registers the job first, then starts it, so its first progress line already has somewhere to go. */
  #track(id: string, order: JobOrder | undefined, start: () => Promise<JobEnd>, stop = new AbortController()): void {
    const entry: Running = {
      order,
      stop,
      buffer: [],
      dropped: 0,
      done: Promise.resolve(),
    };
    this.#jobs.set(id, entry);
    entry.done = (async () => {
      let end: JobEnd;
      try {
        end = await start();
      } catch (error) {
        end = { kind: "result", result: jobError(`The machine could not run the job (${(error as Error).message}).`) };
      }
      if (end.kind === "result") {
        await this.#flushJob(id);
        await this.#deliver(
          id,
          {
            result: end.result,
            ...(end.changes ? { changes: end.changes } : {}),
            ...(end.changesNote ? { changes_note: end.changesNote } : {}),
          },
          stop.signal
        );
        this.#options.log.info("machine-service: job finished", { job: id, outcome: end.result.outcome ?? null });
      } else if (!this.#stopping) {
        this.#options.log.info("machine-service: job stopped by the CRM", { job: id });
      }
      this.#jobs.delete(id);
      try {
        this.#options.onJobDone?.(new Set(this.#jobs.keys()));
      } catch (error) {
        this.#options.log.warn("machine-service: could not clean up job folders", { error: (error as Error).message });
      }
    })();
  }

  /** Stops jobs the CRM has ended. Their results are not sent. */
  cancel(ids: readonly string[]): void {
    for (const id of ids) {
      const job = this.#jobs.get(id);
      if (job && !job.stop.signal.aborted) {
        this.#options.log.info("machine-service: the CRM ended a job; stopping it", { job: id });
        job.stop.abort();
      }
    }
  }

  #buffer(id: string, event: JobEvent): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    job.buffer.push(event);
    if (job.buffer.length > MAX_BUFFERED) {
      job.buffer.shift();
      job.dropped += 1;
    }
  }

  /** Sends buffered progress lines for every job, a batch at a time. */
  async flush(signal?: AbortSignal): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      for (;;) {
        const batches: JobEventBatch[] = [];
        for (const [id, job] of this.#jobs) {
          if (!job.buffer.length) continue;
          // The CRM takes at most BATCH_PER_JOB lines per job, the note about dropped lines included.
          const events = job.buffer.slice(0, job.dropped ? BATCH_PER_JOB - 1 : BATCH_PER_JOB);
          if (job.dropped) {
            events.unshift({ kind: "status", text: `(${job.dropped} earlier progress lines were not sent)` });
          }
          batches.push({ id, events });
        }
        if (!batches.length) return;
        const answer = await this.#options.client.events(this.#options.key, batches, signal);
        const refused = answer.kind === "http" && answer.status === 400;
        // Kept for the next try, unless the CRM refused them: sending the same lines again would never help.
        if (answer.kind !== "ok" && !refused) return;
        if (refused) {
          this.#options.log.warn("machine-service: the CRM refused some progress lines; dropping them", {
            errors: answer.errors ?? null,
          });
        }
        for (const batch of batches) {
          const job = this.#jobs.get(batch.id);
          if (!job) continue;
          const sent = batch.events.length - (job.dropped ? 1 : 0);
          job.buffer.splice(0, sent);
          job.dropped = 0;
        }
        if (answer.kind === "ok") this.cancel(answer.value.ended);
      }
    } finally {
      this.#flushing = false;
    }
  }

  async #flushJob(id: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job?.buffer.length) return;
    while (this.#flushing) await this.#sleep(50, new AbortController().signal);
    await this.flush();
  }

  /** Delivers a result, retrying while the CRM cannot be reached. Gives up on a definite answer. */
  async #deliver(id: string, first: ResultBody, stop: AbortSignal): Promise<void> {
    const attempts = this.#options.resultAttempts ?? DEFAULT_RESULT_ATTEMPTS;
    let body = first;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // A job the CRM ended while the result was on its way needs no result.
      if (stop.aborted) return;
      const answer = await this.#options.client.result(this.#options.key, id, body);
      if (answer.kind === "ok") return;
      // INVALID_RESULT is about the agent's result; any other 400 with changes is about the changed files.
      if (answer.kind === "http" && answer.status === 400 && body.changes && answer.code !== "INVALID_RESULT") {
        // The CRM refused the changed files (a path or a size it does not take): the outcome still counts.
        this.#options.log.warn("machine-service: the CRM refused the job's changed files", {
          job: id,
          errors: answer.errors ?? null,
        });
        body = { result: body.result, changes_note: "the CRM did not accept the changed files" };
        continue;
      }
      if (answer.kind === "http" && answer.status === 400 && body.result.outcome !== "job_error") {
        // The CRM refused the agent's result: report that instead, so the job does not hang.
        this.#options.log.warn("machine-service: the CRM refused the job's result", {
          job: id,
          errors: answer.errors ?? null,
        });
        body = { result: jobError(`The agent's result was not accepted by the CRM: ${summarize(answer.errors)}`) };
        continue;
      }
      if (answer.kind === "http" && answer.status !== 429 && answer.status < 500) {
        // 404 (not this machine's job), 409 (already ended): nothing more to do.
        this.#options.log.info("machine-service: the CRM did not take the result", {
          job: id,
          status: answer.status,
          code: answer.code ?? null,
        });
        return;
      }
      await this.#sleep(this.#options.resultRetryMs ?? DEFAULT_RESULT_RETRY_MS, stop);
    }
    this.#options.log.error("machine-service: could not deliver a job's result; the CRM will end the job", { job: id });
  }

  /** Runs `flush` every `flushMs` until `signal` aborts. */
  async flushLoop(signal: AbortSignal): Promise<void> {
    const every = this.#options.flushMs ?? DEFAULT_FLUSH_MS;
    while (!signal.aborted) {
      await this.#sleep(every, signal);
      if (signal.aborted) break;
      await this.flush(signal).catch(() => undefined);
    }
  }

  /**
   * The service is stopping: stop every job and tell the CRM, quickly and once, that it did not
   * finish. Whatever is not delivered, the CRM ends when the machine stays silent.
   */
  async shutdown(reason: string): Promise<void> {
    this.#stopping = true;
    const jobs = [...this.#jobs.entries()];
    for (const [, job] of jobs) job.stop.abort();
    await Promise.all(
      jobs.map(async ([id, job]) => {
        // Long enough for the agent's grace period and the container's removal (systemd waits 30 s).
        await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, 22_000).unref())]);
        const timeout = AbortSignal.timeout(5_000);
        await this.#options.client
          .result(this.#options.key, id, { result: jobError(reason) }, timeout)
          .catch(() => undefined);
      })
    );
  }

  /** Resolves once every current job has ended and its result was handled (for tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((job) => job.done));
  }
}

function summarize(errors: unknown): string {
  try {
    return JSON.stringify(errors ?? {}).slice(0, 500);
  } catch {
    return "invalid result";
  }
}
