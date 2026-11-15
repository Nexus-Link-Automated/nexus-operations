/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { clampSlots } from "./report.ts";
import { homeOf } from "./system.ts";

/**
 * The machine's own config: which CRM, which machine, and the machine key. The key is a
 * credential, so the file is the owner's alone (0600 in a 0700 dir) and is never printed.
 */

export interface MachineConfig {
  /** The CRM's base URL, without a trailing slash. */
  readonly url: string;
  readonly machineId: string;
  readonly key: string;
  readonly workspaceSlug: string;
  readonly name: string;
  /** How many jobs may run at once (0..32). */
  readonly slots: number;
}

export const CONFIG_DIR_NAME = "nexus-machine";
export const CONFIG_FILE_NAME = "config.json";

/** `$XDG_CONFIG_HOME/nexus-machine`, or `~/.config/nexus-machine`. A relative XDG_CONFIG_HOME is ignored, as the spec says. */
export function configDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), ".config");
  return path.join(base, CONFIG_DIR_NAME);
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), CONFIG_FILE_NAME);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The CRM URL as a base without a trailing slash, or why it is refused. Only https, so the join
 * code and the key never travel in the clear; plain http only to this computer itself (tests and
 * local development).
 */
export function checkCrmUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "The CRM URL is not a valid URL." };
  }
  if (url.username || url.password)
    return { ok: false, error: "The CRM URL must not contain a user name or password." };
  if (url.search || url.hash) return { ok: false, error: "The CRM URL must not contain a query or fragment." };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return { ok: false, error: "The CRM URL must start with https:// (plain http is only allowed to localhost)." };
  }
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type LoadResult =
  | { readonly ok: true; readonly config: MachineConfig }
  | { readonly ok: false; readonly missing: boolean; readonly error: string };

export function loadMachineConfig(file: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      missing,
      error: missing ? "This machine has not joined a CRM yet." : "Cannot read the config.",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, missing: false, error: "The config is not valid JSON." };
  }
  if (!isRecord(value)) return { ok: false, missing: false, error: "The config is not a JSON object." };
  for (const field of ["url", "machineId", "key", "workspaceSlug", "name"] as const) {
    if (typeof value[field] !== "string" || !value[field]) {
      return { ok: false, missing: false, error: `The config has no ${field}.` };
    }
  }
  const url = checkCrmUrl(value.url as string);
  if (!url.ok) return { ok: false, missing: false, error: url.error };
  return {
    ok: true,
    config: {
      url: url.url,
      machineId: value.machineId as string,
      key: value.key as string,
      workspaceSlug: value.workspaceSlug as string,
      name: value.name as string,
      slots: clampSlots(value.slots ?? 1),
    },
  };
}

/**
 * Writes the config atomically: a private temp file next to it, then a rename, so a crash never
 * leaves half a key behind. The dir is made (or tightened) to 0700 and the file is 0600.
 */
export function saveMachineConfig(file: string, config: MachineConfig): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = path.join(dir, `.${CONFIG_FILE_NAME}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "w" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
