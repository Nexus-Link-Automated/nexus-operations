/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Fiber } from "effect";
import type { Request, Response } from "express";
import sharp from "sharp";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfExportController } from "@/controllers/pdf-export.controller";
import { renderPlaneDocToPdfBuffer } from "@/lib/pdf";
import type { PDFExportOptions, TipTapDocument } from "@/lib/pdf";
import { renderPdfInWorker } from "@/lib/pdf/render-in-worker";
import { createExportLimiter } from "@/services/pdf-export/export-limiter";
import { tryAsync, withTimeoutAndRetry } from "@/services/pdf-export/effect-utils";

const mocks = vi.hoisted(() => ({
  fetchDescriptionBinary: vi.fn(),
  doc: { type: "doc", content: [] } as unknown,
  worker: {
    /** Bundled worker that real render tests run against. */
    bundleUrl: undefined as URL | undefined,
    /** Inline worker source; takes priority over the bundle so slot tests can stay fast. */
    script: undefined as string | undefined,
    requestedUrls: [] as string[],
    instances: [] as Array<{ once: (event: "exit", listener: () => void) => void }>,
  },
}));

vi.mock("@/services/page/handler", () => ({
  getPageService: () => ({
    fetchDescriptionBinary: mocks.fetchDescriptionBinary,
    fetchUserMentions: async () => [],
  }),
}));

vi.mock("@plane/editor/server", () => ({
  getAllDocumentFormatsFromDocumentEditorBinaryData: () => ({ contentJSON: mocks.doc, titleHTML: null }),
}));

// Worker threads cannot load TypeScript sources, so the launcher is pointed at a bundle or an inline script.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class RedirectedWorker extends actual.Worker {
    constructor(url: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      const { script, bundleUrl } = mocks.worker;
      mocks.worker.requestedUrls.push(String(url));
      if (script !== undefined) super(script, { ...options, eval: true });
      else super(bundleUrl as URL, options);
      mocks.worker.instances.push(this);
    }
  }
  return { ...actual, default: { ...actual, Worker: RedirectedWorker }, Worker: RedirectedWorker };
});

const MAX_CONCURRENT = 2;
const MAX_QUEUED = 8;
const RETRY_AFTER_SECONDS = 15;
const MAX_EVENT_LOOP_STALL_MS = 500;
const LARGE_DOCUMENT_PARAGRAPHS = 1000;

const PAGE_BINARY = Buffer.from([1, 2, 3]);
const PDF_BYTES = [37, 80, 68, 70, 45];

const RENDER_OK_SCRIPT = `
  const { parentPort } = require("node:worker_threads");
  const bytes = new Uint8Array([${PDF_BYTES.join(",")}]);
  parentPort.postMessage(bytes, [bytes.buffer]);
`;
const RENDER_THROWS_SCRIPT = `throw new Error("render failed");`;
const RENDER_CRASHES_SCRIPT = `process.exit(3);`;
const RENDER_HANGS_SCRIPT = `setInterval(() => {}, 1000);`;

type MockResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: unknown;
  setHeader: (name: string, value: unknown) => MockResponse;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  send: (body: unknown) => MockResponse;
};

type PageGate = { resolve: (binary: Buffer | null) => void };

const createResponse = (): MockResponse => {
  const response: MockResponse = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader: (name, value) => {
      response.headers[name] = value;
      return response;
    },
    status: (code) => {
      response.statusCode = code;
      return response;
    },
    json: (body) => {
      response.body = body;
      return response;
    },
    send: (body) => {
      response.body = body;
      return response;
    },
  };
  return response;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let gates: PageGate[] = [];
let inFlight: Array<Promise<MockResponse>> = [];

const startExport = (request: { cookie?: string; body?: unknown } = {}): Promise<MockResponse> => {
  const { cookie = "session=abc", body = { pageId: "page-1", workspaceSlug: "acme" } } = request;
  const response = createResponse();
  const exported = new PdfExportController()
    .exportToPdf({ headers: { cookie }, body } as unknown as Request, response as unknown as Response)
    .then(() => response);
  inFlight.push(exported);
  return exported;
};

const startedExports = () => mocks.fetchDescriptionBinary.mock.calls.length;

/** Generous because a queued export only starts once the previous export's worker has finished. */
const waitForStartedExports = (count: number) =>
  vi.waitFor(() => expect(startedExports()).toBe(count), { timeout: 20_000 });

/** Keeps answering page fetches until every export has responded, so queued exports can run in turn. */
const finishExports = async (exports: Array<Promise<MockResponse>>, binary: Buffer | null = PAGE_BINARY) => {
  const answerPageFetches = setInterval(() => {
    for (const gate of gates.splice(0)) gate.resolve(binary);
  }, 5);
  try {
    return await Promise.all(exports);
  } finally {
    clearInterval(answerPageFetches);
  }
};

/** Occupies every slot and queue place, and confirms only the slots have started working. */
const fillExportCapacity = async (startedBefore = 0) => {
  const exports = Array.from({ length: MAX_CONCURRENT + MAX_QUEUED }, () => startExport());
  await waitForStartedExports(startedBefore + MAX_CONCURRENT);
  await delay(30);
  expect(startedExports()).toBe(startedBefore + MAX_CONCURRENT);
  return exports;
};

const expectExportToBeTurnedAway = async () => {
  const startedBefore = startedExports();
  const response = await Promise.race([startExport(), delay(10_000).then(() => undefined)]);
  expect(response?.statusCode).toBe(503);
  expect(response?.headers["Retry-After"]).toBe(RETRY_AFTER_SECONDS);
  expect(response?.body).toEqual({ message: expect.stringMatching(/try again/i) });
  expect(startedExports()).toBe(startedBefore);
};

const statusCodes = (responses: MockResponse[]) => responses.map((response) => response.statusCode);

const allStatus = (status: number) => Array.from({ length: MAX_CONCURRENT + MAX_QUEUED }, () => status);

/** Reports the longest gap between timer callbacks, including a gap still open when it is stopped. */
const watchEventLoop = () => {
  let longestStallMs = 0;
  let last = performance.now();
  const sample = () => {
    const now = performance.now();
    longestStallMs = Math.max(longestStallMs, now - last);
    last = now;
  };
  const interval = setInterval(sample, 10);
  return () => {
    sample();
    clearInterval(interval);
    return longestStallMs;
  };
};

/** Masks only the values PDFKit derives from the current time. */
const comparablePdf = (pdf: Buffer) =>
  pdf
    .toString("latin1")
    .replace(/\(D:\d{14}Z\)/g, "(D:timestamp)")
    .replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/g, "/ID [masked]");

beforeEach(() => {
  gates = [];
  inFlight = [];
  mocks.doc = { type: "doc", content: [] };
  mocks.worker.script = RENDER_OK_SCRIPT;
  mocks.worker.requestedUrls = [];
  mocks.worker.instances = [];
  mocks.fetchDescriptionBinary.mockReset();
  mocks.fetchDescriptionBinary.mockImplementation(
    () => new Promise((resolve) => gates.push({ resolve: resolve as PageGate["resolve"] }))
  );
});

afterEach(async () => {
  // A failed assertion must not leave slots held for the next test.
  await finishExports(inFlight);
});

// Each round starts a worker per export, which can take a while on a busy machine.
describe("PDF export limits", { timeout: 30_000 }, () => {
  it("runs two exports at once and starts queued exports as slots free up", async () => {
    const exports = await fillExportCapacity();

    gates.shift()?.resolve(PAGE_BINARY);
    await waitForStartedExports(MAX_CONCURRENT + 1);
    await delay(30);
    expect(startedExports()).toBe(MAX_CONCURRENT + 1);

    const responses = await finishExports(exports);
    expect(statusCodes(responses)).toEqual(allStatus(200));
    expect(startedExports()).toBe(MAX_CONCURRENT + MAX_QUEUED);
  });

  it("answers 503 with Retry-After once the queue is full, without starting the export", async () => {
    await fillExportCapacity();

    await expectExportToBeTurnedAway();
  });

  it("frees slots and queue places after successful exports", async () => {
    const firstRound = await fillExportCapacity();
    await expectExportToBeTurnedAway();
    expect(statusCodes(await finishExports(firstRound))).toEqual(allStatus(200));

    const startedBefore = startedExports();
    const secondRound = await fillExportCapacity(startedBefore);
    await expectExportToBeTurnedAway();
    expect(statusCodes(await finishExports(secondRound))).toEqual(allStatus(200));
  });

  it("frees slots after exports whose page content cannot be loaded", async () => {
    const firstRound = await fillExportCapacity();
    await expectExportToBeTurnedAway();
    expect(statusCodes(await finishExports(firstRound, null))).toEqual(allStatus(404));

    const startedBefore = startedExports();
    const secondRound = await fillExportCapacity(startedBefore);
    await expectExportToBeTurnedAway();
    expect(statusCodes(await finishExports(secondRound))).toEqual(allStatus(200));
  });

  it.each([
    ["throws", RENDER_THROWS_SCRIPT],
    ["exits early", RENDER_CRASHES_SCRIPT],
  ])("frees slots after a render worker %s", async (_outcome, script) => {
    mocks.worker.script = script;
    const firstRound = await fillExportCapacity();
    await expectExportToBeTurnedAway();
    expect(statusCodes(await finishExports(firstRound))).toEqual(allStatus(500));

    mocks.worker.script = RENDER_OK_SCRIPT;
    const startedBefore = startedExports();
    const secondRound = await fillExportCapacity(startedBefore);
    await expectExportToBeTurnedAway();
    expect(statusCodes(await finishExports(secondRound))).toEqual(allStatus(200));
  });

  it("rejects unauthenticated and invalid requests without using capacity", async () => {
    await fillExportCapacity();

    expect((await startExport({ cookie: "" })).statusCode).toBe(401);
    expect((await startExport({ body: { pageId: "" } })).statusCode).toBe(400);
    await expectExportToBeTurnedAway();
  });
});

describe("createExportLimiter", () => {
  const limiter = (maxQueued: number, maxQueueWaitMs = 1000) =>
    createExportLimiter({ maxConcurrent: 1, maxQueued, maxQueueWaitMs });

  const runBlocking = (withSlot: ReturnType<typeof limiter>) => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const running = Effect.runPromise(withSlot(Effect.promise(() => blocked)));
    return { unblock, running };
  };

  it("runs queued effects in the order they arrived", async () => {
    const withSlot = limiter(2);
    const order: string[] = [];
    const { unblock, running } = runBlocking(withSlot);

    const queued = ["first", "second"].map((name) => Effect.runPromise(withSlot(Effect.sync(() => order.push(name)))));
    unblock();
    await Promise.all([running, ...queued]);

    expect(order).toEqual(["first", "second"]);
  });

  it("turns away an effect that waits in the queue for too long and keeps working afterwards", async () => {
    const withSlot = limiter(1, 20);
    const { unblock, running } = runBlocking(withSlot);

    const waited = await Effect.runPromise(withSlot(Effect.succeed("done")).pipe(Effect.either));
    expect(waited).toMatchObject({ _tag: "Left", left: { _tag: "PdfExportBusyError" } });

    unblock();
    await running;
    await expect(Effect.runPromise(withSlot(Effect.succeed("done")))).resolves.toBe("done");
  });

  it.each([
    ["fails", Effect.fail("failed")],
    ["dies", Effect.die("died")],
  ])("frees the slot when the effect %s", async (_outcome, effect) => {
    const withSlot = limiter(0);

    await Effect.runPromiseExit(withSlot(effect));

    await expect(Effect.runPromise(withSlot(Effect.succeed("done")))).resolves.toBe("done");
  });

  it("frees the slot when the effect is interrupted", async () => {
    const withSlot = limiter(0);
    const fiber = Effect.runFork(withSlot(Effect.never));
    await delay(10);

    await Effect.runPromise(Fiber.interrupt(fiber));

    await expect(Effect.runPromise(withSlot(Effect.succeed("done")))).resolves.toBe("done");
  });
});

describe("renderPdfInWorker", () => {
  it("stops the worker when the render exceeds its time limit", async () => {
    mocks.worker.script = RENDER_HANGS_SCRIPT;

    const outcome = await Effect.runPromise(
      tryAsync(
        (signal) => renderPdfInWorker({ type: "doc" }, {}, signal),
        (cause) => cause
      ).pipe(withTimeoutAndRetry("render PDF", { timeoutMs: 100, maxRetries: 0 }), Effect.either)
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { _tag: "PdfTimeoutError" } });
    const [worker] = mocks.worker.instances;
    await new Promise<void>((resolve) => worker.once("exit", resolve));
  });

  it("rejects when the worker exits without a result", async () => {
    mocks.worker.script = RENDER_CRASHES_SCRIPT;

    await expect(renderPdfInWorker({ type: "doc" }, {})).rejects.toThrow(/exited with code 3/);
  });
});

describe("bundled PDF render worker", () => {
  const liveRoot = path.join(import.meta.dirname, "../../..");
  const outDir = path.join(liveRoot, `node_modules/.cache/pdf-render-worker-${process.pid}`);

  beforeAll(async () => {
    // Uses the real build config, so a worker missing from its entries fails here too.
    await build({ config: path.join(liveRoot, "tsdown.config.ts"), outDir, logLevel: "silent" });
    mocks.worker.bundleUrl = pathToFileURL(path.join(outDir, "pdf-render.worker.mjs"));
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mocks.worker.script = undefined;
    mocks.fetchDescriptionBinary.mockResolvedValue(PAGE_BINARY);
  });

  it("renders exports from the file the build places next to the server entry", { timeout: 60_000 }, async () => {
    const response = await startExport();

    expect(response.statusCode).toBe(200);
    expect((response.body as Buffer).toString("ascii", 0, 5)).toBe("%PDF-");
    expect(mocks.worker.requestedUrls).toHaveLength(1);
    const workerFileName = path.basename(new URL(mocks.worker.requestedUrls[0]).pathname);
    expect(existsSync(path.join(outDir, workerFileName))).toBe(true);
    expect(existsSync(path.join(outDir, "start.mjs"))).toBe(true);
  });

  it("produces the same PDF as rendering in-process", { timeout: 60_000 }, async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } })
      .jpeg()
      .toBuffer();
    const doc: TipTapDocument = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Quarterly report" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Bold text ", marks: [{ type: "bold" }] },
            { type: "text", text: "and a link", marks: [{ type: "link", attrs: { href: "https://plane.so" } }] },
            { type: "mention", attrs: { entity_name: "user_mention", entity_identifier: "user-1" } },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] },
          ],
        },
        { type: "imageComponent", attrs: { src: "asset-1", width: 40 } },
      ],
    };
    const options: PDFExportOptions = {
      title: "Quarterly report",
      author: "Plane",
      subject: "Results",
      pageSize: "A3",
      pageOrientation: "landscape",
      metadata: {
        userMentions: [{ id: "user-1", display_name: "Sam" }],
        resolvedImageUrls: { "asset-1": `data:image/jpeg;base64,${image.toString("base64")}` },
      },
    };

    const [fromWorker, inProcess] = [
      await renderPdfInWorker(doc, options),
      await renderPlaneDocToPdfBuffer(doc, options),
    ];

    expect(comparablePdf(fromWorker)).toBe(comparablePdf(inProcess));
  });

  it("keeps the event loop responsive while a large document renders", { retry: 2, timeout: 90_000 }, async () => {
    mocks.doc = {
      type: "doc",
      content: Array.from({ length: LARGE_DOCUMENT_PARAGRAPHS }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `Paragraph ${index} with enough text to need real layout work on the page.` }],
      })),
    };

    const stopWatching = watchEventLoop();
    const response = await startExport();
    const longestStallMs = stopWatching();

    expect(response.statusCode).toBe(200);
    expect(longestStallMs).toBeLessThan(MAX_EVENT_LOOP_STALL_MS);
  });
});
