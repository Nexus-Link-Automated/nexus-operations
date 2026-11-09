/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { HookCallback, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { PACKAGE_ROOT, tempDir } from "./client.ts";

export const FAKE_CLAUDE = path.join(PACKAGE_ROOT, "tests/helpers/fake-claude.cjs");

export interface FakeClaudeStart {
  readonly cmdline: string[];
  readonly mcpConfig?: { path: string; mode: number; content: { mcpServers: Record<string, unknown> } };
}

/** An executable for `pathToClaudeCodeExecutable`, the env that goes with it, and what it recorded. */
export function fakeClaudeExecutable(): {
  executable: string;
  env: Record<string, string>;
  home: string;
  starts: () => FakeClaudeStart[];
} {
  const dir = tempDir("fake-claude-");
  const executable = path.join(dir, "claude");
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(executable, 0o755);
  const logFile = path.join(dir, "log.jsonl");
  const home = tempDir("claude-home-");
  return {
    executable,
    home,
    env: { HOME: home, ANTHROPIC_API_KEY: "sk-ant-test", FAKE_CLAUDE_LOG: logFile },
    starts: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FakeClaudeStart)
        : [],
  };
}

export interface FakeQueryCall {
  readonly prompt: string;
  readonly options: Options;
}

const sessionId = "00000000-0000-4000-8000-000000000001";

function streamEvent(event: Record<string, unknown>): SDKMessage {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: "u",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function assistant(id: string, content: unknown[]): SDKMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: null,
      usage: {},
    },
    parent_tool_use_id: null,
    uuid: "u",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function toolResult(toolUseId: string, text: string, isError: boolean): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function result(stopReason = "end_turn"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    stop_reason: stopReason,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } },
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    permission_denials: [],
    uuid: "u",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

const CANNED_TOOLS: Record<string, { name: string; input: Record<string, unknown> }> = {
  run: { name: "Bash", input: { command: "touch a.txt" } },
  read: { name: "Read", input: { file_path: "a.txt" } },
  todo: {
    name: "TodoWrite",
    input: { todos: [{ content: "Plan it", status: "in_progress", activeForm: "Planning" }] },
  },
};

/** A prompt naming one tool call, as `tool:<Name>:<json input>`, or one of the canned prompts. */
function cannedTool(text: string): { name: string; input: Record<string, unknown> } | undefined {
  const scripted = /^tool:([A-Za-z]+):(.*)$/s.exec(text);
  return scripted ? { name: scripted[1]!, input: JSON.parse(scripted[2]!) } : CANNED_TOOLS[text];
}

/**
 * A stand-in for the Agent SDK's `query()`: yields canned SDK messages and calls the adapter's
 * PreToolUse hook the way Claude Code does before running a tool. Driven by the prompt text:
 * "hello", "run" (Bash), "read" (Read), "todo" (TodoWrite → plan), "wait" (until aborted),
 * "long" (stop_reason max_tokens), "tool:<Name>:<json input>" (that tool call).
 */
export function fakeQuery(): {
  query: (params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => Query;
  calls: FakeQueryCall[];
  /** What the PreToolUse hook answered, one entry per tool call. */
  hookOutputs: { permissionDecision?: string; permissionDecisionReason?: string }[];
} {
  const calls: FakeQueryCall[] = [];
  const hookOutputs: { permissionDecision?: string; permissionDecisionReason?: string }[] = [];
  let messageSeq = 0;
  const query = ({ prompt, options = {} }: { prompt: string | AsyncIterable<unknown>; options?: Options }): Query => {
    const text = typeof prompt === "string" ? prompt : "";
    calls.push({ prompt: text, options });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback | undefined;
    const signal = options.abortController?.signal ?? new AbortController().signal;

    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        tools: [],
      } as unknown as SDKMessage;
      const id = `msg_${++messageSeq}`;
      yield streamEvent({ type: "message_start", message: { id } });
      if (text === "hello" || text === "long") {
        yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
        yield streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Hmm." },
        });
        yield streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        yield streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi " } });
        yield streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "there" } });
        yield assistant(id, [
          { type: "thinking", thinking: "Hmm.", signature: "s" },
          { type: "text", text: "Hi there" },
        ]);
        yield result(text === "long" ? "max_tokens" : "end_turn");
        return;
      }
      const tool = cannedTool(text);
      if (tool) {
        const toolUseId = `toolu_${messageSeq}`;
        const { name, input } = tool;
        yield streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: toolUseId, name, input: {} },
        });
        yield assistant(id, [{ type: "tool_use", id: toolUseId, name, input }]);
        const output = await hook?.(
          {
            hook_event_name: "PreToolUse",
            tool_name: name,
            tool_input: input,
            tool_use_id: toolUseId,
            session_id: sessionId,
            transcript_path: "",
            cwd: options.cwd ?? "",
          } as never,
          toolUseId,
          { signal }
        );
        const specific = (output as { hookSpecificOutput?: (typeof hookOutputs)[number] } | undefined)
          ?.hookSpecificOutput;
        hookOutputs.push(specific ?? {});
        const decision = specific?.permissionDecision;
        if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const allowed = decision === "allow";
        yield toolResult(toolUseId, allowed ? "done" : "The user denied this tool call.", !allowed);
        const reply = `msg_${++messageSeq}`;
        yield streamEvent({ type: "message_start", message: { id: reply } });
        yield streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: allowed ? "ran it" : "skipped" },
        });
        yield assistant(reply, [{ type: "text", text: allowed ? "ran it" : "skipped" }]);
        yield result();
        return;
      }
      if (text === "wait") {
        yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "working" } });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      yield assistant(id, [{ type: "text", text: "ok" }]);
      yield result();
    }

    const generator = run();
    return Object.assign(generator, {
      setPermissionMode: async () => {},
      setModel: async () => {},
      close: () => {},
      interrupt: async () => undefined,
    }) as unknown as Query;
  };
  return { query, calls, hookOutputs };
}
