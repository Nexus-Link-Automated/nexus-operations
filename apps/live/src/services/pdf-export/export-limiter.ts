/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Effect } from "effect";
import { PdfExportBusyError } from "@/schema/pdf-export";

const PDF_EXPORT_MAX_CONCURRENT = 2;
const PDF_EXPORT_MAX_QUEUED = 8;
const PDF_EXPORT_MAX_QUEUE_WAIT_MS = 30_000;
export const PDF_EXPORT_RETRY_AFTER_SECONDS = 15;

const BUSY_MESSAGE = "The server is busy with other PDF exports. Please try again shortly.";

type ExportLimits = {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly maxQueueWaitMs: number;
};

/**
 * Creates a limiter that runs at most `maxConcurrent` effects at once and holds at most `maxQueued` more in
 * first-in, first-out order. Anything over that, or waiting longer than `maxQueueWaitMs`, fails with
 * PdfExportBusyError.
 */
export const createExportLimiter = ({ maxConcurrent, maxQueued, maxQueueWaitMs }: ExportLimits) => {
  let active = 0;
  const waiting: Array<() => void> = [];

  const busy = () => Effect.fail(new PdfExportBusyError({ message: BUSY_MESSAGE }));

  const acquire = Effect.async<void, PdfExportBusyError>((resume) => {
    if (active < maxConcurrent) {
      active += 1;
      resume(Effect.void);
      return;
    }
    if (waiting.length >= maxQueued) {
      resume(busy());
      return;
    }
    const grant = () => {
      clearTimeout(timer);
      resume(Effect.void);
    };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(grant), 1);
      resume(busy());
    }, maxQueueWaitMs);
    waiting.push(grant);
  });

  const release = Effect.sync(() => {
    const next = waiting.shift();
    if (next) {
      // The slot passes straight to the next waiter, so `active` is unchanged.
      next();
    } else {
      active -= 1;
    }
  });

  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | PdfExportBusyError, R> =>
    Effect.acquireUseRelease(
      acquire,
      () => effect,
      () => release
    );
};

/** Shared by every export on this server. */
export const withExportSlot = createExportLimiter({
  maxConcurrent: PDF_EXPORT_MAX_CONCURRENT,
  maxQueued: PDF_EXPORT_MAX_QUEUED,
  maxQueueWaitMs: PDF_EXPORT_MAX_QUEUE_WAIT_MS,
});
