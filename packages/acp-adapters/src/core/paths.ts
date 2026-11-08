/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { agentHome } from "./auth.ts";
import type { ToolCategory } from "./modes.ts";

/** What a file tool may do with a path: go ahead, need the user's approval, or not touch it at all. */
export type PathAccess = "inside" | "outside" | "refused";

/** Something a tool call is about to read or write, as the model spelled it. */
export interface FileTarget {
  /** A file or directory, absolute or relative to the base. Empty means the base itself. */
  readonly path: string;
  /** A glob applied under `path`; it can name files above `path` too (`../x`, `/etc/*`). */
  readonly glob?: string | undefined;
}

export interface PathVerdict {
  readonly access: PathAccess;
  /** The resolved path that decided the verdict, when it is not `inside`. */
  readonly target?: string;
}

export const PATH_REFUSED_MESSAGE =
  "This path is off limits to the agent's file tools: it is process state or holds sign-in credentials. Do not try to reach it another way.";

const PROC_DIR = "/proc";
const MAX_SYMLINK_HOPS = 40;
const GLOB_SYNTAX = /[*?[\]{}()!+@]/;

/** Provider homes under `HOME`, with sign-ins and config that can run commands: nothing else belongs there. */
const PROVIDER_HOMES = [".codex", ".codex-api-key", ".gemini", ".gemini-api-key"];
/** Where Gemini CLI spills long tool output and asks the model to read it back: not a credential store. */
const GEMINI_SCRATCH_DIRS = [".gemini/tmp", ".gemini-api-key/.gemini/tmp"];

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The real location of `absolute`, following symlinks the way the kernel would, including one
 * whose target does not exist yet (a write through it would create that target). `undefined` for a
 * symlink loop.
 */
function canonicalPath(absolute: string): string | undefined {
  const pending = absolute.split(path.sep).filter(Boolean);
  let current: string = path.sep;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    let link: string;
    try {
      link = readlinkSync(next);
    } catch {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) return undefined;
    if (path.isAbsolute(link)) current = path.sep;
    pending.unshift(...link.split(path.sep).filter(Boolean));
  }
  return current;
}

/** The leading part of a glob with no wildcards, and whether `..` follows a wildcard. */
function splitGlob(glob: string): { literal: string; escapes: boolean } {
  const segments = glob.split("/");
  const firstWild = segments.findIndex((segment) => GLOB_SYNTAX.test(segment));
  if (firstWild < 0) return { literal: glob, escapes: false };
  return {
    literal: segments.slice(0, firstWild).join("/") || (glob.startsWith("/") ? "/" : ""),
    escapes: segments.slice(firstWild).some((segment) => segment.includes("..")),
  };
}

/**
 * The file-tool rules for one session. In every mode the tools refuse `/proc` and the provider
 * sign-ins under the agent's `HOME`; in `ask_writes`, reads and searches outside the working
 * directory need approval. Symlinks and `..` are resolved first.
 */
export class PathPolicy {
  readonly #cwd: string;
  readonly #home: string;
  readonly #credentialRoots: readonly string[];
  readonly #scratchRoots: readonly string[];

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    this.#cwd = canonicalPath(path.resolve(cwd)) ?? path.resolve(cwd);
    this.#home = agentHome(env);
    const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(this.#home, ".claude");
    const codexHome = env.CODEX_HOME?.trim();
    const resolvedRoots = (roots: readonly string[]) =>
      [...new Set(roots.flatMap((root) => [root, canonicalPath(root) ?? root]))] as const;
    this.#credentialRoots = resolvedRoots([
      ...PROVIDER_HOMES.map((name) => path.join(this.#home, name)),
      ...(codexHome ? [path.resolve(this.#home, codexHome)] : []),
      path.join(claudeDir, ".credentials.json"),
      path.join(claudeDir, ".claude.json"),
      path.join(claudeDir, "backups"),
      path.join(this.#home, ".claude.json"),
    ]);
    this.#scratchRoots = resolvedRoots(GEMINI_SCRATCH_DIRS.map((name) => path.join(this.#home, name)));
  }

  /** The worst verdict across a tool call's targets; relative paths resolve against `base`. */
  check(targets: readonly FileTarget[], base: string = this.#cwd): PathVerdict {
    let verdict: PathVerdict = { access: "inside" };
    for (const target of targets) {
      const next = this.#checkTarget(target, base);
      if (next.access === "refused") return next;
      if (next.access === "outside" && verdict.access === "inside") verdict = next;
    }
    return verdict;
  }

  /** The real directory a walk of `target` must stay inside; `undefined` when it cannot be resolved. */
  searchRoot(target: FileTarget, base: string = this.#cwd): string | undefined {
    return canonicalPath(path.resolve(this.#absolute(this.#searchStart(target), base)));
  }

  /** Whether a walk rooted at `root` may report or read `found` (absolute); links leaving the root do not count. */
  async allowsFound(root: string, found: string): Promise<boolean> {
    const real = await realpath(found).catch(() => undefined);
    return real !== undefined && isWithin(root, real) && !this.#isOffLimits(real);
  }

  #checkTarget(target: FileTarget, base: string): PathVerdict {
    const verdict = this.#checkPath(this.#absolute(this.#searchStart(target), base));
    if (verdict.access === "inside" && target.glob && splitGlob(target.glob).escapes) {
      return { access: "outside", target: this.#absolute(target.glob, base) };
    }
    return verdict;
  }

  #checkPath(absolute: string): PathVerdict {
    const lexical = path.resolve(absolute);
    // `path.resolve` collapses `a/link/..` without looking at the disk; a tool may not, so check both.
    const reals = [canonicalPath(lexical), canonicalPath(absolute)];
    if (this.#isOffLimits(lexical)) return { access: "refused", target: lexical };
    let verdict: PathVerdict = { access: "inside" };
    for (const real of reals) {
      if (real === undefined || this.#isOffLimits(real)) return { access: "refused", target: real ?? lexical };
      if (!isWithin(this.#cwd, real) && verdict.access === "inside") verdict = { access: "outside", target: real };
    }
    return verdict;
  }

  #searchStart(target: FileTarget): string {
    if (!target.glob) return target.path;
    const { literal } = splitGlob(target.glob);
    if (!literal) return target.path;
    if (!target.path || path.isAbsolute(literal) || literal === "~" || literal.startsWith("~/")) return literal;
    return `${target.path}/${literal}`;
  }

  /** Absolute but not normalised: `..` and symlinks are for `canonicalPath` to resolve. */
  #absolute(raw: string, base: string): string {
    const expanded = raw === "~" ? this.#home : raw.startsWith("~/") ? path.join(this.#home, raw.slice(2)) : raw;
    if (!expanded) return base;
    return path.isAbsolute(expanded) ? expanded : `${base}/${expanded}`;
  }

  #isOffLimits(candidate: string): boolean {
    if (isWithin(PROC_DIR, candidate)) return true;
    // Backups and temp copies sit next to the original: `.claude.json.backup`, `auth.json.tmp`.
    const inCredentials = this.#credentialRoots.some(
      (root) => isWithin(root, candidate) || candidate.startsWith(`${root}.`)
    );
    return inCredentials && !this.#scratchRoots.some((root) => isWithin(root, candidate));
  }
}

/**
 * The gate's view of a read or search: `outside` needs approval and "Always allow" covers only that
 * path, so one approval does not open up the whole disk. Other categories pass through.
 */
export function gateFileRead(
  tool: { readonly category: ToolCategory; readonly memoryKey: string },
  verdict: PathVerdict
): { category: ToolCategory; memoryKey: string } {
  if (verdict.access !== "outside" || (tool.category !== "read" && tool.category !== "search")) {
    return { category: tool.category, memoryKey: tool.memoryKey };
  }
  return { category: "read_outside", memoryKey: `${tool.memoryKey}:${verdict.target ?? ""}` };
}

/** The host of an http(s) URL, for "Always allow" on web fetches; the raw text when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
