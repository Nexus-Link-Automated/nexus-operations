/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("../src/logger.ts", () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error: mocks.logError }),
}));
vi.mock("../src/config.ts", () => ({ loadGatewayConfig: () => ({}) }));
vi.mock("../src/server.ts", () => ({
  ChatGateway: class {
    listen = async () => undefined;
    close = async () => undefined;
  },
}));

const EVENTS = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;
const existing = new Map(EVENTS.map((event) => [event, new Set(process.listeners(event as "SIGTERM"))]));
const addedBy = (event: (typeof EVENTS)[number]) =>
  process.listeners(event as "SIGTERM").filter((listener) => !existing.get(event)!.has(listener));

afterEach(() => {
  for (const event of EVENTS) for (const listener of addedBy(event)) process.off(event, listener);
  vi.restoreAllMocks();
});

it("logs an uncaught exception and exits non-zero", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await import("../src/start.ts");
  const [handler] = addedBy("uncaughtException") as unknown as [(error: Error) => void];
  handler(new Error("something broke"));
  expect(mocks.logError).toHaveBeenCalledWith(
    "chat-gateway: uncaught exception",
    expect.objectContaining({ error: "something broke", stack: expect.stringContaining("something broke") })
  );
  expect(exit).toHaveBeenCalledWith(1);
});
