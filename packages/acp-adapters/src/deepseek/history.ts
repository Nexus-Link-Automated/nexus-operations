/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { agentHome } from "../core/auth.ts";
import { arrayValue, objectValue, stringValue } from "../core/json.ts";
import { readJson, writePrivateFile } from "../core/store.ts";
import type { ChatMessage } from "./index.ts";

/** Under the agent's `HOME`, which the runner keeps per member and deletes when they leave the workspace. */
const HISTORY_DIR = [".plane-acp", "deepseek"] as const;
/** Roughly DeepSeek's 1M-token context window; older turns beyond it are not kept. */
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
/** Conversations kept per `HOME`; the least recently written beyond this are deleted. */
export const MAX_STORED_SESSIONS = 100;
const FORMAT_VERSION = 1;
/** Session ids name files, so anything that could leave the directory is never one. */
const SESSION_ID = /^[\w-]{1,128}$/;
const INTERRUPTED = "The tool call was interrupted.";

/** A conversation as stored for `session/load`. */
export interface StoredHistory {
  /** Without the system prompt, which is rebuilt for the session that loads it. */
  readonly messages: ChatMessage[];
  /** Tool calls that failed or were refused, so the replay shows them that way. */
  readonly failed: string[];
}

/** One file per session: `<HOME>/.plane-acp/deepseek/<session id>.json`, 0600 in a 0700 directory. */
export class HistoryStore {
  readonly #dir: string;

  constructor(env: NodeJS.ProcessEnv) {
    this.#dir = path.join(agentHome(env), ...HISTORY_DIR);
  }

  read(sessionId: string): StoredHistory | undefined {
    const file = this.#file(sessionId);
    if (!file) return undefined;
    const stored = objectValue(readJson(file));
    if (stored.version !== FORMAT_VERSION) return undefined;
    const messages = arrayValue(stored.messages)
      .map(objectValue)
      .filter((message) => ["user", "assistant", "tool"].includes(stringValue(message.role))) as ChatMessage[];
    if (!messages.length) return undefined;
    return { messages, failed: arrayValue(stored.failed).map(stringValue).filter(Boolean) };
  }

  write(sessionId: string, messages: readonly ChatMessage[], failed: ReadonlySet<string>): void {
    const file = this.#file(sessionId);
    if (!file) return;
    const kept = storableMessages(messages);
    if (!kept.length) return;
    const ids = new Set(kept.flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : [])));
    const history = { version: FORMAT_VERSION, messages: kept, failed: [...failed].filter((id) => ids.has(id)) };
    writePrivateFile(file, JSON.stringify(history));
    this.#prune();
  }

  #file(sessionId: string): string | undefined {
    return SESSION_ID.test(sessionId) ? path.join(this.#dir, `${sessionId}.json`) : undefined;
  }

  #prune(): void {
    const files = readdirSync(this.#dir).filter((name) => name.endsWith(".json"));
    if (files.length <= MAX_STORED_SESSIONS) return;
    const byAge = files
      .map((name) => path.join(this.#dir, name))
      // Another agent process of this member may have removed one meanwhile.
      .map((file) => ({ file, mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
      .toSorted((left, right) => left.mtime - right.mtime);
    for (const { file } of byAge.slice(0, files.length - MAX_STORED_SESSIONS)) rmSync(file, { force: true });
  }
}

/**
 * The messages worth storing: every tool call answered (DeepSeek rejects a conversation with one
 * that is not), then whole turns, newest first, while they fit in `MAX_HISTORY_BYTES`. The last
 * turn is always kept.
 */
export function storableMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const turns: ChatMessage[][] = [];
  for (const message of answerToolCalls(messages)) {
    if (message.role === "system") continue;
    const current = turns.at(-1);
    if (message.role === "user" || !current) turns.push([message]);
    else current.push(message);
  }
  let size = 0;
  let first = turns.length;
  while (first > 0) {
    size += Buffer.byteLength(JSON.stringify(turns[first - 1]));
    if (size > MAX_HISTORY_BYTES && first < turns.length) break;
    first -= 1;
  }
  return turns.slice(first).flat();
}

/** `messages` with a result for every tool call that has none, e.g. when the process stopped mid-turn. */
function answerToolCalls(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let open: string[] = [];
  const close = () => {
    for (const id of open) result.push({ role: "tool", tool_call_id: id, content: INTERRUPTED });
    open = [];
  };
  for (const message of messages) {
    if (message.role === "tool") {
      open = open.filter((id) => id !== message.tool_call_id);
    } else {
      close();
      if (message.role === "assistant") open = (message.tool_calls ?? []).map((call) => call.id);
    }
    result.push(message);
  }
  close();
  return result;
}
