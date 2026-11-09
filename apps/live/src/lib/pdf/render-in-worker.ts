/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Worker } from "node:worker_threads";
import type { PDFExportOptions, PdfRenderWorkerData, TipTapDocument } from "./types";

// tsdown.config.ts emits the worker next to the server entry.
const PDF_RENDER_WORKER_URL = new URL("./pdf-render.worker.mjs", import.meta.url);

/**
 * Renders a document on its own worker thread so layout work never blocks the collaboration event loop.
 * Aborting the signal stops the worker, because a timed-out render would otherwise keep using a CPU core.
 */
export const renderPdfInWorker = (
  doc: TipTapDocument,
  options: PDFExportOptions,
  signal?: AbortSignal
): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const workerData: PdfRenderWorkerData = { doc, options };
    const worker = new Worker(PDF_RENDER_WORKER_URL, { workerData });
    const stop = () => void worker.terminate();

    signal?.addEventListener("abort", stop, { once: true });
    worker.once("message", (bytes: Uint8Array) => {
      resolve(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", stop);
      // No effect once a result has been delivered; otherwise the worker ended without producing one.
      reject(new Error(`PDF render worker exited with code ${code} before returning a result`));
    });
  });
