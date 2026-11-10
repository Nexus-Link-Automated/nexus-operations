/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { PathPolicy } from "../src/core/paths.ts";
import { BUILTIN_TOOLS, type ToolRunContext } from "../src/deepseek/tools.ts";
import { tempDir } from "./helpers/client.ts";

const bash = BUILTIN_TOOLS.find((tool) => tool.name === "bash")!;

function context(cwd: string, signal: AbortSignal = new AbortController().signal): ToolRunContext {
  return {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    signal,
    emit: async () => undefined,
    fetch,
    paths: {} as PathPolicy,
  };
}

/** A subshell that would create `marker` a second later, unless the group it belongs to is killed first. */
const delayedMarker = "(sleep 1; touch marker) & wait";

describe("DeepSeek bash tool", () => {
  it("kills everything the command started when it times out", async () => {
    const cwd = tempDir();
    const result = await bash.run({ command: delayedMarker, timeout_ms: 100 }, context(cwd));
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("timed out after 100 ms");
    await sleep(1300);
    expect(existsSync(path.join(cwd, "marker"))).toBe(false);
  });

  it("kills everything the command started when the turn is cancelled", async () => {
    const cwd = tempDir();
    const controller = new AbortController();
    const running = bash.run({ command: delayedMarker }, context(cwd, controller.signal));
    await sleep(100);
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("cancelled") });
    await sleep(1300);
    expect(existsSync(path.join(cwd, "marker"))).toBe(false);
  });

  it("does not wait for a background process holding the output pipe", async () => {
    const started = Date.now();
    const result = await bash.run({ command: "sleep 5 & echo $!" }, context(tempDir()));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.isError).toBe(false);
    const [status, pid] = result.text.split("\n");
    expect(status).toBe("exit code 0");
    process.kill(Number(pid), "SIGKILL");
  });

  it("reports a failing command's exit code and output", async () => {
    const result = await bash.run({ command: "echo out; exit 3" }, context(tempDir()));
    expect(result).toEqual({ text: "exit code 3\nout\n", isError: true });
  });
});
