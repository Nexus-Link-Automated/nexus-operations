/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import os from "node:os";

import { claudeCredential, codexAuthFile, codexSignIn } from "./signins.ts";
import { findOnPath, mapLimit, type CommandRunner, type MachineFs } from "./system.ts";
import { MACHINE_VERSION } from "./version.ts";

/**
 * What the machine reports about itself in every heartbeat. The CRM's schema is strict (unknown
 * fields are refused, every capabilities field is required), so these types list exactly its
 * fields and every string is cut to the CRM's limits here.
 */

export const LIMITS = {
  hostname: 255,
  os: 64,
  version: 32,
  agentVersion: 64,
  toolchainName: 32,
  toolchainVersion: 64,
  dockerVersion: 64,
  toolchains: 30,
  slots: 32,
} as const;

export const AGENT_IDS = ["codex", "claude"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentReport {
  readonly id: AgentId;
  readonly installed: boolean;
  readonly signed_in: boolean;
  readonly version: string | null;
}

export interface ToolchainReport {
  readonly name: string;
  readonly version: string;
}

export interface DockerReport {
  readonly available: boolean;
  readonly version: string | null;
}

export interface SlotsReport {
  readonly total: number;
  readonly free: number;
}

export interface Capabilities {
  readonly agents: AgentReport[];
  readonly toolchains: ToolchainReport[];
  readonly docker: DockerReport;
  readonly slots: SlotsReport;
}

/** `hostname`, `os` and `version`, sent with the join and with every heartbeat. */
export interface About {
  readonly hostname: string;
  readonly os: string;
  readonly version: string;
}

/**
 * The toolchains looked for, in report order: the command and how to ask it for its version.
 * Docker is reported on its own (`docker`), from its daemon rather than its CLI.
 */
export const TOOLCHAINS: readonly { readonly name: string; readonly args: readonly string[] }[] = [
  { name: "git", args: ["--version"] },
  { name: "gh", args: ["--version"] },
  { name: "node", args: ["--version"] },
  { name: "npm", args: ["--version"] },
  { name: "pnpm", args: ["--version"] },
  { name: "yarn", args: ["--version"] },
  { name: "bun", args: ["--version"] },
  { name: "deno", args: ["--version"] },
  { name: "python3", args: ["--version"] },
  { name: "uv", args: ["--version"] },
  { name: "go", args: ["version"] },
  { name: "rustc", args: ["--version"] },
  { name: "cargo", args: ["--version"] },
  { name: "java", args: ["--version"] },
  { name: "dotnet", args: ["--version"] },
  { name: "ruby", args: ["--version"] },
  { name: "php", args: ["--version"] },
  { name: "make", args: ["--version"] },
  { name: "gcc", args: ["--version"] },
];

/** Per external command. Generous, because a cold `dotnet` or `java` can take a few seconds. */
export const COMMAND_TIMEOUT_MS = 10_000;
/** How many detection commands run at once. */
const CONCURRENCY = 4;

export interface DetectDeps {
  readonly run: CommandRunner;
  readonly fs: MachineFs;
  readonly env: NodeJS.ProcessEnv;
}

/** Cut to at most `max` characters, counted as the CRM counts them (code points, not UTF-16 units). */
export function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : chars.slice(0, max).join("").trimEnd();
}

const VERSION_PATTERN = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * The version number in a `--version` answer: `git version 2.43.0` → `2.43.0`, `v24.1.0` →
 * `24.1.0`, `2.0.14 (Claude Code)` → `2.0.14`. Without one, the first line as printed.
 */
export function parseVersion(output: string, max: number): string | undefined {
  const match = VERSION_PATTERN.exec(output);
  if (match) return truncate(match[0], max);
  const firstLine = output.split("\n").find((line) => line.trim());
  return firstLine ? truncate(firstLine, max) : undefined;
}

async function versionOf(deps: DetectDeps, file: string, args: readonly string[], max: number) {
  const result = await deps.run(file, args, { timeoutMs: COMMAND_TIMEOUT_MS, env: deps.env });
  if (result.code !== 0) return undefined;
  // Some tools (old java, some pythons) answer on stderr.
  return parseVersion(result.stdout.trim() ? result.stdout : result.stderr, max);
}

function readJsonObject(fs: MachineFs, file: string): Record<string, unknown> | undefined {
  const text = fs.readText(file);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Codex sign-in, as a job can use it: jobs run in a container and get a copy of
 * `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) holding ChatGPT tokens or an API key saved
 * with `codex login --with-api-key` (`signins.ts`). A sign-in kept in the OS keyring instead of the
 * file cannot be copied into a container, so it does not count. An `OPENAI_API_KEY` in the env
 * alone does not count either: the CLI does not sign in with it unless it is saved as above.
 */
export function codexSignedIn(deps: DetectDeps): boolean {
  return codexSignIn(readJsonObject(deps.fs, codexAuthFile(deps.env))) !== undefined;
}

/**
 * Claude sign-in, as a job can use it: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from
 * `claude setup-token`) in the service's env, the two the Claude adapter accepts
 * (`@plane/acp-adapters` `src/claude/index.ts`). A sign-in the Claude CLI keeps for itself
 * (`~/.claude/.credentials.json`) is not used by jobs, so it does not count.
 */
export function claudeSignedIn(deps: DetectDeps): boolean {
  return claudeCredential(deps.env) !== undefined;
}

async function detectAgent(deps: DetectDeps, id: AgentId): Promise<AgentReport> {
  const binary = findOnPath(id, deps.env, deps.fs);
  const version = binary ? await versionOf(deps, binary, ["--version"], LIMITS.agentVersion) : undefined;
  const signedIn = id === "codex" ? codexSignedIn(deps) : claudeSignedIn(deps);
  return { id, installed: binary !== undefined, signed_in: signedIn, version: version ?? null };
}

async function detectDocker(deps: DetectDeps): Promise<DockerReport> {
  const binary = findOnPath("docker", deps.env, deps.fs);
  if (!binary) return { available: false, version: null };
  // Asks the daemon, so it fails (non-zero) when the daemon is down or this user may not use it.
  const result = await deps.run(binary, ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: COMMAND_TIMEOUT_MS,
    env: deps.env,
  });
  const version = result.code === 0 ? truncate(result.stdout, LIMITS.dockerVersion) : "";
  return version ? { available: true, version } : { available: false, version: null };
}

async function detectToolchains(deps: DetectDeps): Promise<ToolchainReport[]> {
  const found = TOOLCHAINS.flatMap((tool) => {
    const binary = findOnPath(tool.name, deps.env, deps.fs);
    return binary ? [{ ...tool, binary }] : [];
  });
  const reports = await mapLimit(found, CONCURRENCY, async (tool) => ({
    name: truncate(tool.name, LIMITS.toolchainName),
    // Found but not answering (an old java without `--version`): still reported, without a version.
    version: (await versionOf(deps, tool.binary, tool.args, LIMITS.toolchainVersion)) ?? "",
  }));
  return reports.slice(0, LIMITS.toolchains);
}

/** Clamp to the CRM's 0..32 slots. */
export function clampSlots(total: unknown): number {
  const value = typeof total === "number" && Number.isFinite(total) ? Math.trunc(total) : 1;
  return Math.min(LIMITS.slots, Math.max(0, value));
}

/** The capabilities report. Never throws; whatever cannot be detected reads as absent. */
export async function detectCapabilities(deps: DetectDeps, slots: number): Promise<Capabilities> {
  const [agents, toolchains, docker] = await Promise.all([
    Promise.all(AGENT_IDS.map((id) => detectAgent(deps, id).catch(() => absentAgent(id)))),
    detectToolchains(deps).catch(() => []),
    detectDocker(deps).catch(() => ({ available: false, version: null })),
  ]);
  const total = clampSlots(slots);
  // `free` here is before running jobs are counted; the service lowers it on every heartbeat (`adjust`).
  return { agents, toolchains, docker, slots: { total, free: total } };
}

function absentAgent(id: AgentId): AgentReport {
  return { id, installed: false, signed_in: false, version: null };
}

/** `PRETTY_NAME` from os-release, e.g. `Ubuntu 24.04.1 LTS`. */
function distroName(fs: MachineFs): string | undefined {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    const text = fs.readText(file);
    const match = text ? /^PRETTY_NAME=(["']?)(.*)\1\s*$/m.exec(text) : undefined;
    if (match?.[2]) return match[2];
  }
  return undefined;
}

export interface AboutDeps {
  readonly fs: MachineFs;
  readonly hostname?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: () => string;
  readonly version?: string;
}

/** Hostname, `linux x64 Ubuntu 24.04.1 LTS` and the service's version, cut to the CRM's limits. */
export function aboutMachine(deps: AboutDeps): About {
  const platform = deps.platform ?? process.platform;
  const describe = platform === "linux" ? distroName(deps.fs) : undefined;
  const release = describe ?? (deps.release ?? os.release)();
  return {
    hostname: truncate((deps.hostname ?? os.hostname)(), LIMITS.hostname),
    os: truncate(`${platform} ${deps.arch ?? process.arch} ${release}`, LIMITS.os),
    version: truncate(deps.version ?? MACHINE_VERSION, LIMITS.version),
  };
}
