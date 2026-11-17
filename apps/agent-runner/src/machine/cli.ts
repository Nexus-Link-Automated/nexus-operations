/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "../logger.ts";
import { CrmClient, type FetchLike } from "./client.ts";
import { jobsDir, pruneJobDirs, runJob } from "./job.ts";
import { a2aAsker } from "./questions.ts";
import { JobManager } from "./jobs.ts";
import { DockerSandboxProvider, type SandboxProvider } from "./sandbox.ts";
import { checkConfigWritable, checkCrmUrl, configPath, loadMachineConfig, saveMachineConfig } from "./config.ts";
import { createMachineLogger } from "./log.ts";
import {
  aboutMachine,
  clampSlots,
  detectCapabilities,
  LIMITS,
  type About,
  type Capabilities,
  type DetectDeps,
} from "./report.ts";
import {
  defaultSleep,
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  runMachine,
  type RunOptions,
} from "./service.ts";
import { defaultCommandRunner, defaultMachineFs, type CommandRunner, type MachineFs } from "./system.ts";
import { MACHINE_VERSION } from "./version.ts";

export const USAGE = `Usage: nexus-machine <command>

Commands:
  join <crm-url> [<join-code>] [--slots N] [--force]
                 Trade a one-time join code for this machine's key and save it. Leave the
                 code out to read it from NEXUS_MACHINE_JOIN_CODE (kept out of shell history).
                 --slots: how many jobs may run at once (0-${LIMITS.slots}, default 1).
                 --force: replace an existing config (the old machine stays in the CRM).
  run            Stay connected to the CRM and run the coding jobs it hands out, each in
                 its own Docker container.
  prepare        Build the job container image now (run does it on first start).
  status         Show the saved config (never the key) and what this machine reports.
  version        Print the version.

Exit codes: 0 ok, 1 failed, 64 bad usage, 78 not joined or the key no longer works.`;

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Aborted on SIGTERM/SIGINT. */
  readonly signal: AbortSignal;
  readonly fetch?: FetchLike;
  readonly run?: CommandRunner;
  readonly fs?: MachineFs;
  readonly about?: About;
  readonly log?: Logger;
  readonly runOptions?: Partial<Pick<RunOptions, "sleep" | "random" | "now" | "backoff" | "redetectMs">>;
  /** Where jobs run; Docker unless a test gives another. */
  readonly sandbox?: (machineId: string, log: Logger) => SandboxProvider;
}

/** How often the job image is checked again while it is not ready (Docker stopped, a build failed). */
const PREPARE_RETRY_MS = 5 * 60_000;

/** `job-image/` next to the bundle (install.sh puts it there), or `NEXUS_MACHINE_JOB_IMAGE_DIR`. */
export function jobImageDir(env: NodeJS.ProcessEnv): string {
  const override = env.NEXUS_MACHINE_JOB_IMAGE_DIR?.trim();
  if (override && path.isAbsolute(override)) return override;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "job-image");
}

function dockerSandbox(deps: CliDeps, machineId: string, log: Logger): SandboxProvider {
  if (deps.sandbox) return deps.sandbox(machineId, log);
  const memory = deps.env.NEXUS_MACHINE_JOB_MEMORY?.trim();
  const cpus = deps.env.NEXUS_MACHINE_JOB_CPUS?.trim();
  const egress = deps.env.NEXUS_MACHINE_JOB_EGRESS?.trim() === "open" ? "open" : "proxy";
  if (egress === "open") log.warn("machine-service: NEXUS_MACHINE_JOB_EGRESS=open: jobs reach your LAN and the host");
  const egressPorts = deps.env.NEXUS_MACHINE_EGRESS_PORTS?.trim();
  return new DockerSandboxProvider({
    egress,
    ...(egressPorts ? { egressPorts } : {}),
    machineId,
    contextDir: jobImageDir(deps.env),
    env: deps.env,
    log,
    ...(deps.run ? { run: deps.run } : {}),
    ...(memory ? { memory } : {}),
    ...(cpus ? { cpus } : {}),
  });
}

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

function parseArgs(args: readonly string[]): Parsed | string {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--slots") {
      const value = args[i + 1];
      if (value === undefined) return "--slots needs a number";
      flags.set("slots", value);
      i++;
    } else if (arg.startsWith("--slots=")) {
      flags.set("slots", arg.slice("--slots=".length));
    } else if (arg === "--force") {
      flags.set("force", true);
    } else if (arg === "--help" || arg === "-h") {
      flags.set("help", true);
    } else if (arg.startsWith("-")) {
      return `unknown option ${arg}`;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    (command ? deps.out : deps.err)(USAGE);
    return command ? EXIT_OK : EXIT_USAGE;
  }
  const parsed = parseArgs(rest);
  if (typeof parsed === "string") {
    deps.err(`nexus-machine: ${parsed}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.flags.has("help")) {
    deps.out(USAGE);
    return EXIT_OK;
  }
  switch (command) {
    case "join":
      return join(parsed, deps);
    case "run":
      return run(deps);
    case "status":
      return status(deps);
    case "prepare":
      return prepare(deps);
    case "version":
    case "--version":
      deps.out(MACHINE_VERSION);
      return EXIT_OK;
    default:
      deps.err(`nexus-machine: unknown command ${command}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}

function detectDeps(deps: CliDeps): DetectDeps {
  return { run: deps.run ?? defaultCommandRunner, fs: deps.fs ?? defaultMachineFs, env: deps.env };
}

function about(deps: CliDeps): About {
  return deps.about ?? aboutMachine({ fs: deps.fs ?? defaultMachineFs });
}

async function join(parsed: Parsed, deps: CliDeps): Promise<number> {
  const [rawUrl, codeArg, ...extra] = parsed.positional;
  // The code may come from NEXUS_MACHINE_JOIN_CODE instead, so it is not in the shell's history or the process list.
  const rawCode = codeArg ?? deps.env.NEXUS_MACHINE_JOIN_CODE?.trim();
  if (!rawUrl || !rawCode || extra.length > 0) {
    deps.err(`nexus-machine: join takes <crm-url> <join-code>\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const url = checkCrmUrl(rawUrl);
  if (!url.ok) {
    deps.err(`nexus-machine: ${url.error}`);
    return EXIT_USAGE;
  }
  const slotsFlag = parsed.flags.get("slots");
  let slots = 1;
  if (slotsFlag !== undefined) {
    const value = Number(slotsFlag);
    if (!Number.isInteger(value) || value < 0 || value > LIMITS.slots) {
      deps.err(`nexus-machine: --slots must be a whole number from 0 to ${LIMITS.slots}`);
      return EXIT_USAGE;
    }
    slots = clampSlots(value);
  }
  const file = configPath(deps.env);
  if (existsSync(file) && !parsed.flags.has("force")) {
    deps.err(
      `nexus-machine: this machine has already joined (${file}). Use --force to replace that config with a new join.`
    );
    return EXIT_FAILURE;
  }
  // The code works once: find out now, not after spending it, that the key could not be saved.
  try {
    checkConfigWritable(file);
  } catch (error) {
    deps.err(`nexus-machine: cannot save the config at ${file} (${(error as Error).message}). Nothing was sent.`);
    return EXIT_FAILURE;
  }

  const client = new CrmClient(url.url, deps.fetch ? { fetch: deps.fetch } : {});
  const result = await client.join(rawCode.trim(), about(deps), deps.signal);
  if (result.kind === "network") {
    deps.err(`nexus-machine: could not reach the CRM at ${url.url} (${result.error}).`);
    return EXIT_FAILURE;
  }
  if (result.kind === "http") {
    if (result.code === "JOIN_CODE_INVALID") {
      deps.err(
        "nexus-machine: the join code was refused: it is wrong, already used or expired. Add the machine again in the CRM for a new code."
      );
    } else if (result.status === 429) {
      deps.err("nexus-machine: too many join attempts from this address; try again later.");
    } else {
      deps.err(`nexus-machine: the CRM refused the join (${result.status}${result.code ? ` ${result.code}` : ""}).`);
    }
    return EXIT_FAILURE;
  }
  const answer = result.value;
  try {
    saveMachineConfig(file, {
      url: url.url,
      machineId: answer.machineId,
      key: answer.key,
      workspaceSlug: answer.workspaceSlug,
      name: answer.name,
      slots,
    });
  } catch (error) {
    // The code is used up now; say so plainly, the key itself is never printed.
    deps.err(`nexus-machine: joined, but could not save ${file} (${(error as Error).message}). Add the machine again.`);
    return EXIT_FAILURE;
  }
  deps.out(`Joined as "${answer.name}" in workspace ${answer.workspaceSlug}. Saved to ${file}.`);
  if (answer.state === "awaiting_approval") {
    deps.out("The owner must approve this machine in the CRM before it gets jobs.");
  }
  deps.out("Next: systemctl --user enable --now nexus-machine   (or run it in the foreground: nexus-machine run)");
  return EXIT_OK;
}

async function run(deps: CliDeps): Promise<number> {
  const log = deps.log ?? createMachineLogger({ debug: deps.env.NEXUS_MACHINE_DEBUG === "1" });
  const loaded = loadMachineConfig(configPath(deps.env));
  if (!loaded.ok) {
    log.error(`machine-service: ${loaded.error} Run: nexus-machine join <crm-url> <join-code>`, {
      config: configPath(deps.env),
    });
    return EXIT_CONFIG;
  }
  const { config } = loaded;
  const detect = detectDeps(deps);
  const client = new CrmClient(config.url, deps.fetch ? { fetch: deps.fetch } : {});
  const sandbox = dockerSandbox(deps, config.machineId, log);
  const root = jobsDir(deps.env);
  pruneJobDirs(root, new Set());
  // Containers of jobs a previous run was running cannot be picked up again: the CRM ends those jobs.
  const leftovers = await sandbox.removeLeftovers().catch(() => 0);
  if (leftovers) log.warn("machine-service: removed job containers left from a previous run", { count: leftovers });
  const ask = a2aAsker(client, config.key);
  const jobs = new JobManager({
    key: config.key,
    slots: config.slots,
    client,
    log,
    canRun: () => sandbox.status().ready,
    run: (order, emit, stop) =>
      runJob(order, { sandboxes: sandbox, jobsRoot: root, env: deps.env, log, emit, ask }, stop),
    onJobDone: (running) => pruneJobDirs(root, running),
  });
  const done = new AbortController();
  const preparing = keepPrepared(sandbox, log, AbortSignal.any([deps.signal, done.signal]));
  // Agents run in the job image, so they count as installed once it is ready; running jobs take slots.
  const adjust = (capabilities: Capabilities): Capabilities => {
    const ready = sandbox.status().ready;
    return {
      ...capabilities,
      agents: capabilities.agents.map((agent) => ({ ...agent, installed: ready })),
      slots: { total: capabilities.slots.total, free: ready ? Math.min(capabilities.slots.total, jobs.free) : 0 },
    };
  };
  const code = await runMachine({
    config,
    client,
    about: about(deps),
    detect: () => detectCapabilities(detect, config.slots),
    log,
    signal: deps.signal,
    jobs,
    adjust,
    ...deps.runOptions,
  });
  done.abort();
  await preparing;
  // Whatever jobs left, and the egress proxy, go now, also when the key stopped working (78).
  await sandbox.shutdown?.().catch(() => undefined);
  return code;
}

/** Gets the job image ready, and tries again every few minutes while it is not. */
async function keepPrepared(sandbox: SandboxProvider, log: Logger, signal: AbortSignal): Promise<void> {
  let lastReason: string | undefined;
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- one preparation at a time
    const prepared = await sandbox.prepare(signal);
    if (prepared.ready) return;
    if (prepared.reason !== lastReason) {
      log.warn(`machine-service: cannot run jobs yet: ${prepared.reason ?? "unknown"}; retrying every few minutes`);
      lastReason = prepared.reason;
    }
    // oxlint-disable-next-line no-await-in-loop -- waits between attempts
    await defaultSleep(PREPARE_RETRY_MS, signal);
  }
}

async function prepare(deps: CliDeps): Promise<number> {
  const log = deps.log ?? createMachineLogger({ debug: deps.env.NEXUS_MACHINE_DEBUG === "1" });
  const loaded = loadMachineConfig(configPath(deps.env));
  const machineId = loaded.ok ? loaded.config.machineId : "unjoined";
  const prepared = await dockerSandbox(deps, machineId, log).prepare(deps.signal);
  if (prepared.ready) {
    deps.out("The job image is ready.");
    return EXIT_OK;
  }
  deps.err(`nexus-machine: the job image is not ready: ${prepared.reason ?? "unknown"}.`);
  return EXIT_FAILURE;
}

async function status(deps: CliDeps): Promise<number> {
  const file = configPath(deps.env);
  const loaded = loadMachineConfig(file);
  let slots = 1;
  if (loaded.ok) {
    const { config } = loaded;
    slots = config.slots;
    deps.out(`Config:     ${file}`);
    deps.out(`CRM:        ${config.url}`);
    deps.out(`Workspace:  ${config.workspaceSlug}`);
    deps.out(`Machine:    ${config.name} (${config.machineId})`);
    deps.out(`Slots:      ${config.slots}`);
  } else {
    deps.out(`Config:     ${file}: ${loaded.error}`);
  }
  const report = {
    ...about(deps),
    capabilities: await detectCapabilities(detectDeps(deps), slots),
  };
  deps.out(`Report sent with each heartbeat:\n${JSON.stringify(report, null, 2)}`);
  return EXIT_OK;
}
