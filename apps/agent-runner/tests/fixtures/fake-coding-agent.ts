#!/usr/bin/env node
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Test fixture: a coding agent on the adapters' own ACP stdio runtime (like plane-acp-echo), whose
// behaviour `FAKE_AGENT_MODE` picks:
// - `fixed` (default): says something, runs a "tool", changes a file in its cwd, writes a `fixed` result;
// - `bug_found`: writes a `bug_found` result with extra fields the machine must drop;
// - `no_result`: ends its turn without a result;
// - `bad_json`: writes a result file that is not JSON;
// - `wait`: works until it is cancelled;
// - `crash`: exits in the middle of the turn.
// It records the mode it was started in and its env in `$NEXUS_RESULT_FILE.env.json` for the tests.
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { StopReason } from "@agentclientprotocol/sdk";

import { sleep } from "../../../../packages/acp-adapters/src/core/abort.ts";
import type { AgentAdapter, SessionInit, TurnContext } from "../../../../packages/acp-adapters/src/core/agent.ts";
import { agentInfo } from "../../../../packages/acp-adapters/src/core/info.ts";
import { runStdioAgent } from "../../../../packages/acp-adapters/src/core/stdio.ts";

const mode = process.env.FAKE_AGENT_MODE ?? "fixed";
const resultFile = process.env.NEXUS_RESULT_FILE ?? "";

function writeResult(value: unknown): void {
  writeFileSync(resultFile, typeof value === "string" ? value : JSON.stringify(value));
}

const adapter: AgentAdapter = {
  info: agentInfo("fake-coding-agent", "Fake coding agent"),
  models: () => ({ options: [{ value: "fake", name: "Fake" }], current: "fake" }),
  startSession: async (init: SessionInit) => ({
    async prompt(turn: TurnContext): Promise<StopReason> {
      const { host } = init;
      writeFileSync(
        `${resultFile}.env.json`,
        JSON.stringify({
          mode: host.mode(),
          cwd: process.cwd(),
          secret: process.env.ANTHROPIC_API_KEY ?? null,
          auth: process.env.PLANE_AGENT_AUTH ?? null,
          prompt: turn.prompt.map((block) => ("text" in block ? block.text : "")).join(""),
        })
      );
      await turn.messages.text("Looking at the bug. ");
      await turn.messages.text("Found it.");
      turn.messages.breakMessage();
      const toolCallId = await host.toolCalls.start(undefined, { title: "Run the tests", kind: "execute" });
      await host.toolCalls.update(toolCallId, { status: "completed" });
      if (mode === "crash") process.exit(3);
      if (mode === "wait") {
        await sleep(600_000, turn.signal).catch(() => undefined);
        return "cancelled";
      }
      if (mode === "no_result") return "end_turn";
      if (mode === "bad_json") {
        writeResult("{not json");
        return "end_turn";
      }
      writeFileSync(path.join(process.cwd(), "fix.txt"), "fixed\n");
      if (mode === "bug_found") {
        writeResult({
          outcome: "bug_found",
          test_name: "test_login",
          expected: "200",
          actual: "500",
          output: "AssertionError",
          diagnosis: { likely_cause: "missing null check", file: "app/auth.py", line: 12, extra: "dropped" },
          reproduce: "pytest tests/test_login.py",
          pr_url: "https://example.com/made-up",
          surprise: "dropped",
        });
        return "end_turn";
      }
      writeResult({ outcome: "fixed", summary: "Added a null check." });
      return "end_turn";
    },
  }),
};

await runStdioAgent(adapter);
