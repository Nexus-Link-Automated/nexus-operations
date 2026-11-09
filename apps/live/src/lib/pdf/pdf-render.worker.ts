/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { parentPort, workerData } from "node:worker_threads";
import { renderPlaneDocToPdfBuffer } from "./plane-pdf-exporter";
import type { PdfRenderWorkerData } from "./types";

const { doc, options } = workerData as PdfRenderWorkerData;

const pdf = await renderPlaneDocToPdfBuffer(doc, options);

// Copied into its own ArrayBuffer so it can be transferred instead of cloned on the main thread.
const bytes = new Uint8Array(pdf);
parentPort?.postMessage(bytes, [bytes.buffer]);
