/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { JobEvent } from "./client.ts";

/**
 * Turns the agent's ACP stream into a few readable progress lines for the work item's jobs panel:
 * what it said (message chunks joined into one line per message), which tools it ran (and which
 * failed), and its plan. Thoughts, usage and the rest are left out. Lines are plain text; the CRM
 * shows them as text.
 */

/** Matches the CRM's limit per line (`EVENT_TEXT_MAX`). */
export const EVENT_TEXT_MAX = 2000;

type Update = SessionNotification["update"];

function cut(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length <= EVENT_TEXT_MAX ? chars.join("") : `${chars.slice(0, EVENT_TEXT_MAX - 1).join("")}…`;
}

function textOf(content: unknown): string {
  if (typeof content !== "object" || content === null) return "";
  const record = content as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string" ? record.text : "";
}

export class ProgressCondenser {
  #message = "";
  readonly #titles = new Map<string, string>();
  readonly #emit: (event: JobEvent) => void;

  constructor(emit: (event: JobEvent) => void) {
    this.#emit = emit;
  }

  status(text: string): void {
    this.flush();
    this.#emit({ kind: "status", text: cut(text) });
  }

  update(update: Update): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        this.#message += textOf(update.content);
        if (this.#message.length >= EVENT_TEXT_MAX) this.flush();
        return;
      }
      case "tool_call": {
        this.flush();
        const title = update.title?.trim() || "a tool";
        this.#titles.set(update.toolCallId, title);
        this.#emit({ kind: "tool", text: cut(title) });
        if (update.status === "failed") this.#emit({ kind: "tool", text: cut(`Failed: ${title}`) });
        return;
      }
      case "tool_call_update": {
        if (update.title) this.#titles.set(update.toolCallId, update.title);
        if (update.status === "failed") {
          this.flush();
          const title = this.#titles.get(update.toolCallId) ?? "a tool";
          this.#emit({ kind: "tool", text: cut(`Failed: ${title}`) });
        }
        return;
      }
      case "plan": {
        this.flush();
        const lines = update.entries.map((entry) => {
          const mark = entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[>]" : "[ ]";
          return `${mark} ${entry.content}`;
        });
        if (lines.length) this.#emit({ kind: "plan", text: cut(lines.join("\n")) });
        return;
      }
      default:
        return;
    }
  }

  /** Emit the message gathered so far as one line. */
  flush(): void {
    const text = this.#message.trim();
    this.#message = "";
    if (text) this.#emit({ kind: "message", text: cut(text) });
  }
}
