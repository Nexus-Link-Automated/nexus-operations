/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentId } from "./report.ts";
import type { AgentEnv } from "./sandbox.ts";
import { readRegularFile } from "./files.ts";
import { CONTAINER_HOME } from "./sandbox.ts";
import { homeOf } from "./system.ts";

/**
 * The machine's own sign-ins, made available to one job's container and nothing more.
 *
 * - Codex: the ChatGPT sign-in (or saved API key) in `$CODEX_HOME/auth.json` (default
 *   `~/.codex/auth.json`) is copied into the job's home. Codex refreshes its tokens while it works
 *   and may rotate them, so a refreshed copy is written back afterwards, unless the original
 *   changed meanwhile (another job wrote it back first).
 * - Claude: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the
 *   service's environment (its env file). The Claude adapter takes only these; a sign-in kept by
 *   the Claude CLI itself is not used for jobs.
 *
 * Credentials are passed by name to `docker exec`, never on a command line, and the job's home is
 * removed when the job ends. The agent can still read its own sign-in inside the container: the
 * container is what keeps everything else (the owner's files and other sign-ins) out of reach.
 */

export interface StagedSignIn {
  readonly env: AgentEnv;
  /** After the job: write a refreshed Codex sign-in back to the machine's own. */
  finish(): void;
}

export class SignInMissing extends Error {}

const MAX_AUTH_BYTES = 256 * 1024;

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return parseObject(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const AUTH_KEYS = new Set(["OPENAI_API_KEY", "tokens", "last_refresh"]);
const TOKEN_KEYS = new Set(["id_token", "access_token", "refresh_token", "account_id"]);

/**
 * Whether `next` is Codex's refresh of the `original` ChatGPT sign-in rather than something a job
 * put there: only Codex's own keys, tokens present, and the same account (`tokens.account_id`).
 * Without an account id in the original nothing can be compared, so nothing is written back.
 */
export function isRefreshOf(original: Record<string, unknown>, next: Record<string, unknown> | undefined): boolean {
  if (!next || codexSignIn(next) !== "chatgpt") return false;
  if (Object.keys(next).some((key) => !AUTH_KEYS.has(key))) return false;
  const before = original.tokens as Record<string, unknown> | undefined;
  const after = next.tokens as Record<string, unknown>;
  if (Object.keys(after).some((key) => !TOKEN_KEYS.has(key))) return false;
  return nonEmpty(before?.account_id) && after.account_id === before.account_id;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function codexAuthFile(env: NodeJS.ProcessEnv): string {
  const home = homeOf(env);
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return path.join(path.resolve(home, codexHome), "auth.json");
}

export type CodexSignIn = "chatgpt" | "api_key" | undefined;

/** Which Codex sign-in `auth.json` holds, if any. */
export function codexSignIn(auth: Record<string, unknown> | undefined): CodexSignIn {
  if (!auth) return undefined;
  const tokens = auth.tokens;
  if (typeof tokens === "object" && tokens !== null) {
    const record = tokens as Record<string, unknown>;
    if (nonEmpty(record.access_token) || nonEmpty(record.refresh_token)) return "chatgpt";
  }
  return nonEmpty(auth.OPENAI_API_KEY) ? "api_key" : undefined;
}

/** The Claude credential the service's environment has, if any. */
export function claudeCredential(env: NodeJS.ProcessEnv): { name: string; value: string } | undefined {
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    const value = env[name];
    if (nonEmpty(value)) return { name, value: value.trim() };
  }
  return undefined;
}

function writePrivate(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "w" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Gives the job's home (`homeDir`, seen as `/job/home` inside) the agent's sign-in. */
export function stageSignIn(agent: AgentId, homeDir: string, env: NodeJS.ProcessEnv): StagedSignIn {
  if (agent === "claude") {
    const credential = claudeCredential(env);
    if (!credential) {
      throw new SignInMissing(
        "Claude is not signed in on this machine: put ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from " +
          "`claude setup-token`, in the machine service's env file."
      );
    }
    return { env: { plain: {}, secret: { [credential.name]: credential.value } }, finish: () => undefined };
  }

  const source = codexAuthFile(env);
  let original: string;
  try {
    original = readFileSync(source, "utf8");
  } catch {
    throw new SignInMissing("Codex is not signed in on this machine: run `codex login` as the machine's owner.");
  }
  const auth = readJson(source);
  const kind = codexSignIn(auth);
  if (!kind || !auth) {
    throw new SignInMissing("Codex is not signed in on this machine: run `codex login` as the machine's owner.");
  }
  if (kind === "api_key") {
    return {
      env: {
        plain: { PLANE_AGENT_AUTH: "api_key", CODEX_HOME: `${CONTAINER_HOME}/.codex-api-key` },
        secret: { OPENAI_API_KEY: (auth.OPENAI_API_KEY as string).trim() },
      },
      finish: () => undefined,
    };
  }
  const staged = path.join(homeDir, ".codex", "auth.json");
  writePrivate(staged, original);
  return {
    env: { plain: { PLANE_AGENT_AUTH: "chatgpt", CODEX_HOME: `${CONTAINER_HOME}/.codex` }, secret: {} },
    finish() {
      // The container could write this file: read it as a regular file only, never through a link.
      const copy = readRegularFile(staged, MAX_AUTH_BYTES);
      let current: string;
      try {
        current = readFileSync(source, "utf8");
      } catch {
        return;
      }
      if (!copy.ok || copy.text === original || current !== original) return;
      // Only a refresh of the same sign-in, and only over the one this job started from.
      if (!isRefreshOf(auth, parseObject(copy.text))) return;
      writePrivate(source, copy.text);
    },
  };
}
