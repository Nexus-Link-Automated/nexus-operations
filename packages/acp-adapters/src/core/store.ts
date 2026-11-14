/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensurePrivateDir } from "./auth.ts";
import { objectValue, stringValue, type JsonObject } from "./json.ts";

/** Our ACP session id → the provider's own id, so `session/load` finds the conversation. */
export const SESSION_MAP_FILE = "plane-acp-sessions.json";
const MAX_MAPPED_SESSIONS = 500;

export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Write a file atomically, readable by its owner only. */
export function writePrivateFile(file: string, data: string): void {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, file);
}

/** Write a JSON file atomically, readable by its owner only. */
export function writePrivateJson(file: string, value: unknown): void {
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Our session id → the provider's, persisted next to the provider's own session storage. */
export class SessionMap {
  readonly #file: string;

  constructor(dir: string) {
    this.#file = path.join(dir, SESSION_MAP_FILE);
  }

  get(sessionId: string): string | undefined {
    return stringValue(this.#read()[sessionId]) || undefined;
  }

  set(sessionId: string, providerSessionId: string): void {
    const entries = Object.entries(this.#read()).filter(([key]) => key !== sessionId);
    entries.push([sessionId, providerSessionId]);
    writePrivateJson(this.#file, Object.fromEntries(entries.slice(-MAX_MAPPED_SESSIONS)));
  }

  #read(): JsonObject {
    return objectValue(readJson(this.#file));
  }
}
