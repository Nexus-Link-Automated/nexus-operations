/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The two things detection needs from the computer: running a command and reading a file. Both
 * are injectable so tests do not depend on what is installed, and neither ever throws.
 */

export interface CommandResult {
  /** The exit code; `null` when the command could not start, was killed or timed out. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  /** Stops the command (and its process group) early. */
  readonly signal?: AbortSignal;
}

export type CommandRunner = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export interface MachineFs {
  /** The file's text, or `undefined` when it is missing, unreadable, not a file or too large. */
  readText(file: string): string | undefined;
  /** Whether `file` is a regular file this user may execute. */
  isExecutable(file: string): boolean;
}

/** Enough for any `--version` answer; anything longer is cut, never buffered without bound. */
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

/**
 * Runs `file args` with no shell, stdin closed and a hard timeout. The command gets its own
 * process group so a timeout also kills what it started (`codex` and `pnpm` are shims that start
 * another process).
 */
export const defaultCommandRunner: CommandRunner = (file, args, { timeoutMs, env, signal }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The one place the promise settles; `close`, `error` and the timeout may all call it.
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` lets only the first call through
      resolve({ code, stdout, stderr });
    };
    let child: ReturnType<typeof spawn> | undefined;
    const onAbort = () => {
      killGroup(child?.pid);
      finish(null);
    };
    if (signal?.aborted) {
      finish(null);
      return;
    }
    try {
      child = spawn(file, [...args], {
        cwd: homeOf(env),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      killGroup(child?.pid);
      finish(null);
    }, timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.slice(0, MAX_OUTPUT_BYTES - stdout.length);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.slice(0, MAX_OUTPUT_BYTES - stderr.length);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      // Anything the command left running in its group goes with it.
      killGroup(child?.pid);
      finish(code);
    });
  });

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export const defaultMachineFs: MachineFs = {
  readText(file) {
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return undefined;
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  isExecutable(file) {
    try {
      if (!statSync(file).isFile()) return false;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** The user's home: `HOME`, else the OS's idea of it. */
export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

/**
 * The absolute path of `name` on `PATH`, like `command -v`. Relative `PATH` entries are skipped:
 * they would resolve against whatever directory the service happens to run in.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, fs: MachineFs): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (fs.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** `items.map(fn)` with at most `limit` running at once, so detection does not start 20 processes at once. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      // oxlint-disable-next-line no-await-in-loop -- each worker handles one item at a time on purpose
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
