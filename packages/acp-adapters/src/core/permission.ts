/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import path from "node:path";

import type { AgentContext, PermissionOption, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";

import { requiresPermission, type PermissionModeId, type ToolCategory } from "./modes.ts";

/** What an "always allow" answer covers; the prompt has to say which. */
export type MemoryScope = "command" | "file" | "path" | "host" | "request" | "tool";

/** `_meta` key on the "always" option naming its scope, so the web app can show a translated label. */
export const MEMORY_SCOPE_META_KEY = "plane/memoryScope";

const ALWAYS_ALLOW_NAMES: Readonly<Record<MemoryScope, string>> = {
  command: "Always allow this exact command in this chat",
  file: "Always allow edits to this file in this chat",
  path: "Always allow reading this path in this chat",
  host: "Always allow fetching from this host in this chat",
  request: "Always allow this exact request in this chat",
  tool: "Always allow this tool in this chat",
};

/** The prompt's options. `null`: the answer cannot be remembered, so "always" is not offered. */
export function permissionOptions(scope: MemoryScope | null): PermissionOption[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    ...(scope
      ? [
          {
            optionId: "allow_always",
            name: ALWAYS_ALLOW_NAMES[scope],
            kind: "allow_always" as const,
            _meta: { [MEMORY_SCOPE_META_KEY]: scope },
          },
        ]
      : []),
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ];
}

export interface PermissionMemory {
  readonly memoryKey: string | null;
  readonly memoryScope: MemoryScope;
}

/**
 * Separators, pipes, background jobs, redirection, substitution, and ANSI-C quoting (which can spell
 * any of those as an escape). Matched anywhere, quoted or not: Codex reports commands as
 * `/bin/bash -lc '<script>'`, so the part that matters is always inside quotes. A quoted `;` in a
 * harmless argument is refused too; that costs one extra prompt.
 */
const COMPOUND_SHELL = /[;&|<>`\r\n]|\$[(']/;

/**
 * Collapses runs of spaces and tabs between arguments and leaves quoted or escaped text alone, so
 * `echo "a  b"` and `echo "a b"` stay different. An unterminated quote yields `null`.
 */
function normaliseShellCommand(command: string): string | null {
  let out = "";
  let quote = "";
  let pendingSpace = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (!quote && (char === " " || char === "\t")) {
      pendingSpace = out !== "";
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
    if (char === "\\" && quote !== "'") {
      index += 1;
      out += command.charAt(index);
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return quote || !out ? null : out;
}

/** "Always allow" for one shell command: this exact command only, and never a compound one. */
export function shellCommandMemory(prefix: string, command: string): PermissionMemory {
  const normalised = COMPOUND_SHELL.test(command) ? null : normaliseShellCommand(command);
  return { memoryKey: normalised ? `${prefix}:${normalised}` : null, memoryScope: "command" };
}

/** "Always allow" for edits to one file. A change spanning several files is not remembered. */
export function fileMemory(cwd: string, files: readonly string[]): PermissionMemory {
  const file = files.length === 1 ? files[0] : undefined;
  return { memoryKey: file ? `file:${path.resolve(cwd, file)}` : null, memoryScope: "file" };
}

export interface PermissionCheck {
  /** ACP tool call this request is about; it must already have been announced with `tool_call`. */
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: ToolKind;
  readonly category: ToolCategory;
  readonly rawInput?: unknown;
  /**
   * What an "always allow" answer covers, e.g. `Bash:git status` or `mcp:plane:workitem:create`.
   * `null` means it cannot be remembered, so "always" is not offered. Defaults to the title.
   */
  readonly memoryKey?: string | null;
  /** How the prompt describes that coverage. Defaults to `tool`. */
  readonly memoryScope?: MemoryScope | undefined;
}

/**
 * `allowed`: run the tool. `rejected`: the user said no. `cancelled`: the turn was cancelled while
 * the prompt was open; the caller should stop the turn.
 */
export type PermissionDecision = "allowed" | "rejected" | "cancelled";

/**
 * Mode gate plus `session/request_permission`, with per-session "always allow" memory. One per
 * ACP session; the mode is read live so `session/set_mode` takes effect on the next tool call,
 * including mid-turn.
 */
export class PermissionGate {
  readonly #client: AgentContext;
  readonly #sessionId: string;
  readonly #mode: () => PermissionModeId;
  readonly #alwaysAllowed = new Set<string>();

  constructor(client: AgentContext, sessionId: string, mode: () => PermissionModeId) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#mode = mode;
  }

  /** True when `check` would answer without asking the user. */
  wouldAllowSilently(category: ToolCategory, memoryKey: string | null): boolean {
    return !requiresPermission(this.#mode(), category) || (memoryKey !== null && this.#alwaysAllowed.has(memoryKey));
  }

  async check(request: PermissionCheck, signal: AbortSignal): Promise<PermissionDecision> {
    if (signal.aborted) return "cancelled";
    const memoryKey = request.memoryKey === undefined ? request.title : request.memoryKey;
    if (this.wouldAllowSilently(request.category, memoryKey)) return "allowed";

    const toolCall: ToolCallUpdate = {
      toolCallId: request.toolCallId,
      title: request.title,
      kind: request.kind,
      status: "pending",
      ...(request.rawInput === undefined ? {} : { rawInput: request.rawInput }),
    };
    let optionId: string;
    try {
      const response = await this.#client.request(
        "session/request_permission",
        {
          sessionId: this.#sessionId,
          toolCall,
          options: permissionOptions(memoryKey === null ? null : (request.memoryScope ?? "tool")),
        },
        { cancellationSignal: signal }
      );
      if (response.outcome.outcome === "cancelled") return "cancelled";
      optionId = response.outcome.optionId;
    } catch (error) {
      if (signal.aborted) return "cancelled";
      throw error;
    }
    if (signal.aborted) return "cancelled";
    if (optionId === "allow_always") {
      if (memoryKey !== null) this.#alwaysAllowed.add(memoryKey);
      return "allowed";
    }
    return optionId === "allow_once" ? "allowed" : "rejected";
  }
}
