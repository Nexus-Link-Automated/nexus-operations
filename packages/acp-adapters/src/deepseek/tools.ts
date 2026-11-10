/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- grep reads files one at a time to bound memory and stop early */
import { spawn } from "node:child_process";
import { glob, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlanEntry, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";

import { arrayValue, numberValue, objectValue, stringValue, type JsonObject } from "../core/json.ts";
import type { ToolCategory } from "../core/modes.ts";
import type { FileTarget, PathPolicy } from "../core/paths.ts";
import type { Emit } from "../core/turn.ts";

export interface ToolRunContext {
  readonly cwd: string;
  /** Environment for commands, with credentials already removed. */
  readonly env: Record<string, string>;
  readonly signal: AbortSignal;
  readonly emit: Emit;
  readonly fetch: typeof fetch;
  readonly paths: PathPolicy;
}

export interface ToolResult {
  readonly text: string;
  readonly isError?: boolean;
  /** Rich ACP content for the tool call card (diffs); `text` is what the model sees. */
  readonly content?: ToolCallContent[];
}

export interface BuiltinTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  category(input: JsonObject): ToolCategory;
  title(input: JsonObject): string;
  locations?(input: JsonObject, cwd: string): ToolCallLocation[];
  /** Files and directories this call touches, checked against the session's path rules. */
  targets?(input: JsonObject): FileTarget[];
  run(input: JsonObject, context: ToolRunContext): Promise<ToolResult>;
}

const MAX_OUTPUT_CHARS = 64_000;
const MAX_READ_BYTES = 2_000_000;
const DEFAULT_READ_LINES = 2_000;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 600_000;
/** After a command's shell has gone, how long to keep reading output that is still in flight. */
const OUTPUT_DRAIN_MS = 200;
const FETCH_TIMEOUT_MS = 30_000;
const SKIP_DIRS = /(^|\/)(node_modules|\.git)(\/|$)/;

function resolvePath(cwd: string, value: unknown): string {
  const raw = stringValue(value);
  if (!raw) throw new Error("a path is required");
  return path.resolve(cwd, raw);
}

function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]` : text;
}

function fileLocation(input: JsonObject, cwd: string): ToolCallLocation[] {
  const raw = stringValue(input.path);
  return raw ? [{ path: path.resolve(cwd, raw) }] : [];
}

const fileTarget = (input: JsonObject): FileTarget[] => [{ path: stringValue(input.path) }];

/**
 * Process groups of the commands still running. Each is outside the agent's own group, so the
 * runner's signal to that group no longer reaches them when the agent is stopped.
 */
const runningGroups = new Set<number>();

function killGroup(group: number): void {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // The whole group has already exited.
  }
}

process.on("exit", () => {
  for (const group of runningGroups) killGroup(group);
});

const bash: BuiltinTool = {
  name: "bash",
  description:
    "Run a shell command with bash in the working directory. Returns the exit code and combined stdout/stderr (truncated when long).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      timeout_ms: {
        type: "integer",
        description: `Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, max ${MAX_BASH_TIMEOUT_MS}).`,
      },
    },
    required: ["command"],
  },
  category: () => "execute",
  title: (input) => `Run: ${stringValue(input.command).slice(0, 120)}`,
  async run(input, { cwd, env, signal }) {
    const command = stringValue(input.command);
    if (!command) return { text: "command is required", isError: true };
    if (signal.aborted) return { text: "cancelled", isError: true };
    const requested = numberValue(input.timeout_ms);
    const timeout = Math.min(requested && requested > 0 ? requested : DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
    return new Promise<ToolResult>((resolve) => {
      // Its own process group, so a timeout or cancel reaches everything the command started.
      const child = spawn("bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const group = child.pid;
      if (group !== undefined) runningGroups.add(group);

      let output = "";
      let stopped: string | undefined;
      let exited: { code: number | null; killedBy: NodeJS.Signals | null } | undefined;
      let draining = false;

      // Runs again when "close" follows a report made after the drain; every step is a no-op then.
      const cleanUp = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (group !== undefined) runningGroups.delete(group);
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const finish = (result: ToolResult) => {
        cleanUp();
        resolve(result);
      };
      const report = () => {
        const status = stopped ?? (exited?.killedBy ? `killed by ${exited.killedBy}` : `exit code ${exited?.code}`);
        finish({ text: truncate(`${status}\n${output}`), isError: stopped !== undefined || exited?.code !== 0 });
      };
      // A process that left the group can hold the pipes open for as long as it runs, so "close" may never come.
      const drainThenReport = () => {
        if (draining) return;
        draining = true;
        clearTimeout(timer);
        // oxlint-disable-next-line promise/no-multiple-resolved -- schedules a report, which resolves once
        timer = setTimeout(report, OUTPUT_DRAIN_MS);
      };
      const stop = (reason: string) => {
        if (stopped || exited) return;
        stopped = reason;
        if (group !== undefined) killGroup(group);
        drainThenReport();
      };
      const onAbort = () => stop("cancelled");
      let timer = setTimeout(() => stop(`timed out after ${timeout} ms`), timeout);
      signal.addEventListener("abort", onAbort, { once: true });

      const append = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT_CHARS * 2) output += chunk.toString("utf8");
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => finish({ text: `failed to run: ${error.message}`, isError: true }));
      child.on("exit", (code, killedBy) => {
        exited = { code, killedBy };
        drainThenReport();
      });
      child.on("close", report);
    });
  },
};

const read: BuiltinTool = {
  name: "read",
  description: "Read a text file. Lines are numbered. Use offset (1-based) and limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", description: "First line to return, 1-based." },
      limit: { type: "integer", description: `Number of lines (default ${DEFAULT_READ_LINES}).` },
    },
    required: ["path"],
  },
  category: () => "read",
  title: (input) => `Read ${stringValue(input.path)}`,
  locations: fileLocation,
  targets: fileTarget,
  async run(input, { cwd }) {
    const file = resolvePath(cwd, input.path);
    const info = await stat(file);
    if (info.size > MAX_READ_BYTES) return { text: `${file} is ${info.size} bytes; too large to read`, isError: true };
    const lines = (await readFile(file, "utf8")).split("\n");
    const offset = Math.max(1, numberValue(input.offset) ?? 1);
    const limit = Math.max(1, numberValue(input.limit) ?? DEFAULT_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return { text: truncate(slice.map((line, index) => `${offset + index}\t${line}`).join("\n")) };
  },
};

const write: BuiltinTool = {
  name: "write",
  description: "Create or overwrite a file with the given content. Parent directories are created.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  category: () => "edit",
  title: (input) => `Write ${stringValue(input.path)}`,
  locations: fileLocation,
  targets: fileTarget,
  async run(input, { cwd }) {
    const file = resolvePath(cwd, input.path);
    const content = stringValue(input.content);
    const oldText = await readFile(file, "utf8").catch(() => null);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return {
      text: `wrote ${content.length} characters to ${file}`,
      content: [{ type: "diff", path: file, oldText, newText: content }],
    };
  },
};

const edit: BuiltinTool = {
  name: "edit",
  description:
    "Replace exact text in a file. old_string must match exactly once unless replace_all is true. Read the file first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  },
  category: () => "edit",
  title: (input) => `Edit ${stringValue(input.path)}`,
  locations: fileLocation,
  targets: fileTarget,
  async run(input, { cwd }) {
    const file = resolvePath(cwd, input.path);
    const oldString = stringValue(input.old_string);
    const newString = stringValue(input.new_string);
    if (!oldString) return { text: "old_string must not be empty", isError: true };
    const oldText = await readFile(file, "utf8");
    const count = oldText.split(oldString).length - 1;
    if (count === 0) return { text: `old_string was not found in ${file}`, isError: true };
    if (count > 1 && input.replace_all !== true) {
      return { text: `old_string matches ${count} times in ${file}; add context or set replace_all`, isError: true };
    }
    const newText =
      input.replace_all === true
        ? oldText.split(oldString).join(newString)
        : oldText.replace(oldString, () => newString);
    await writeFile(file, newText);
    return {
      text: `edited ${file} (${count} replacement${count === 1 ? "" : "s"})`,
      content: [{ type: "diff", path: file, oldText, newText }],
    };
  },
};

async function listFiles(
  base: string,
  pattern: string,
  { paths, signal }: Pick<ToolRunContext, "paths" | "signal">,
  limit: number
): Promise<string[]> {
  const out: string[] = [];
  const root = paths.searchRoot({ path: base, glob: pattern });
  if (root === undefined) return out;
  for await (const entry of glob(pattern, { cwd: base, exclude: (name: string) => SKIP_DIRS.test(name) })) {
    if (signal.aborted) break;
    if (SKIP_DIRS.test(entry)) continue;
    // A walk follows symlinks it finds, which can lead out of what was checked before it started.
    if (!(await paths.allowsFound(root, path.resolve(base, entry)))) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

const globTool: BuiltinTool = {
  name: "glob",
  description: "Find files by glob pattern (e.g. **/*.ts), relative to path or the working directory.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory to search from." } },
    required: ["pattern"],
  },
  category: () => "search",
  title: (input) => `Find ${stringValue(input.pattern)}`,
  targets: (input) => [{ path: stringValue(input.path), glob: stringValue(input.pattern) }],
  async run(input, { cwd, signal, paths }) {
    const base = input.path ? resolvePath(cwd, input.path) : cwd;
    const files = await listFiles(base, stringValue(input.pattern) || "*", { paths, signal }, MAX_GLOB_RESULTS);
    return { text: files.length ? files.join("\n") : "no matches" };
  },
};

const grep: BuiltinTool = {
  name: "grep",
  description: "Search file contents with a regular expression. Returns file:line:text matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: { type: "string", description: "Directory to search from." },
      glob: { type: "string", description: "Only search files matching this glob (default **/*)." },
      case_insensitive: { type: "boolean" },
    },
    required: ["pattern"],
  },
  category: () => "search",
  title: (input) => `Search "${stringValue(input.pattern)}"`,
  targets: (input) => [{ path: stringValue(input.path), glob: stringValue(input.glob) }],
  async run(input, { cwd, signal, paths }) {
    const base = input.path ? resolvePath(cwd, input.path) : cwd;
    let regex: RegExp;
    try {
      regex = new RegExp(stringValue(input.pattern), input.case_insensitive === true ? "i" : "");
    } catch (error) {
      return { text: `invalid pattern: ${(error as Error).message}`, isError: true };
    }
    const matches: string[] = [];
    for (const file of await listFiles(base, stringValue(input.glob) || "**/*", { paths, signal }, 20_000)) {
      if (signal.aborted || matches.length >= MAX_GREP_MATCHES) break;
      const full = path.resolve(base, file);
      const info = await stat(full).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_READ_BYTES) continue;
      const text = await readFile(full, "utf8").catch(() => "");
      if (text.includes("\0")) continue;
      text.split("\n").forEach((line, index) => {
        if (matches.length < MAX_GREP_MATCHES && regex.test(line))
          matches.push(`${file}:${index + 1}:${line.slice(0, 300)}`);
      });
    }
    return { text: matches.length ? matches.join("\n") : "no matches" };
  },
};

const webFetch: BuiltinTool = {
  name: "web_fetch",
  description: "Fetch an http(s) URL and return its text (HTML is reduced to text).",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  category: () => "fetch",
  title: (input) => `Fetch ${stringValue(input.url)}`,
  async run(input, { signal, fetch: fetchImpl }) {
    const url = new URL(stringValue(input.url));
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { text: "only http(s) URLs are supported", isError: true };
    const response = await fetchImpl(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      redirect: "follow",
    });
    const body = await response.text();
    const type = response.headers.get("content-type") ?? "";
    const text = type.includes("html") ? htmlToText(body) : body;
    return { text: truncate(`HTTP ${response.status}\n${text}`), isError: !response.ok };
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

const todo: BuiltinTool = {
  name: "todo",
  description: "Replace the task list shown to the user. Send the full list each time.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  category: () => "think",
  title: () => "Update plan",
  async run(input, { emit }) {
    const entries: PlanEntry[] = arrayValue(input.todos).map((value) => {
      const item = objectValue(value);
      const status = stringValue(item.status);
      return {
        content: stringValue(item.content),
        priority: "medium",
        status: PLAN_STATUSES.has(status) ? (status as PlanEntry["status"]) : "pending",
      };
    });
    await emit({ sessionUpdate: "plan", entries });
    return { text: "plan updated" };
  },
};

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [bash, read, write, edit, globTool, grep, webFetch, todo];
