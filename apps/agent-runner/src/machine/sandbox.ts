/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Logger } from "../logger.ts";
import type { JobOrder } from "./orders.ts";
import type { AgentId } from "./report.ts";
import { isCommit } from "./changes.ts";
import { defaultCommandRunner, type CommandRunner } from "./system.ts";
import { MACHINE_VERSION } from "./version.ts";

/**
 * Where a job runs: a Docker container of its own, started from the job image
 * (`machine/job-image/Dockerfile`: Node, git, a small toolbox, the Codex CLI and the ACP adapters).
 * Work-item text can steer the agent, so the agent never runs on the owner's account directly:
 * the container sees only the job's own folders, runs as the owner's uid without capabilities
 * or privilege escalation, and never gets the docker socket, the owner's home, SSH keys or the
 * machine's key.
 *
 * Host folders (under the service's data dir, one per job, 0700) and where the container sees them:
 *
 * | Host              | Container   | Holds                                                    |
 * | ----------------- | ----------- | -------------------------------------------------------- |
 * | `<job>/work`      | `/job/work` | the clone (`/job/work/repo`), the agent's working dir    |
 * | `<job>/home`      | `/job/home` | `HOME`: the agent's sign-in copy, caches; removed after  |
 * | `<job>/out`       | `/job/out`  | `result.json`, which the agent writes                    |
 */

export const CONTAINER_WORK = "/job/work";
export const CONTAINER_REPO = "/job/work/repo";
export const CONTAINER_HOME = "/job/home";
export const CONTAINER_OUT = "/job/out";
export const CONTAINER_RESULT_FILE = "/job/out/result.json";
/** Where the agent writes a question for the CRM (`{"question": "..."}`) before it ends its turn. */
export const CONTAINER_QUESTION_FILE = "/job/out/question.json";
/** Where `collectChanges` writes the job's changes as a patch (`git diff --binary`). */
export const CONTAINER_PATCH_FILE = "/job/out/changes.patch";
/** Where `collectChanges` lists the changed files (`git diff --raw -z --no-renames`). */
export const CONTAINER_CHANGES_LIST = "/job/out/changes.list";
/** Where the job image keeps the adapters (`machine/job-image/Dockerfile`). */
export const ADAPTER_BIN: Record<AgentId, string> = {
  codex: "/opt/nexus/acp/dist/bin/codex.mjs",
  claude: "/opt/nexus/acp/dist/bin/claude.mjs",
};
export const IMAGE_REPOSITORY = "nexus-machine-job";
/** The job image's egress proxy (`machine/job-image/egress-proxy.mjs`) and where job containers reach it. */
export const EGRESS_PROXY_SCRIPT = "/opt/nexus/egress-proxy.mjs";
export const EGRESS_ALIAS = "nexus-egress";
export const EGRESS_PORT = 3128;
/** `docker network inspect` → "true isolated" for the jobs' network as it must be. */
export const NETWORK_FORMAT = '{{.Internal}} {{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}';
/** `docker inspect` of the proxy → "<running> <image> <network> <network> ... " */
export const PROXY_FORMAT =
  "{{.State.Running}} {{.Config.Image}} {{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}";
export const LABEL_MACHINE = "nexus-machine.machine";
export const LABEL_JOB = "nexus-machine.job";
export const LABEL_EGRESS = "nexus-machine.egress";

const CLONE_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 45 * 60_000;

export interface JobDirs {
  readonly root: string;
  readonly work: string;
  readonly home: string;
  readonly out: string;
}

export interface AgentEnv {
  /** Plain settings, passed by value. */
  readonly plain: Readonly<Record<string, string>>;
  /** Credentials: passed by name only, so they never appear on a command line. */
  readonly secret: Readonly<Record<string, string>>;
}

export interface AgentProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  /** Resolves with the exit code (null when killed) once the agent has ended. */
  readonly exited: Promise<number | null>;
  /** The last lines it wrote to stderr, for a job error. */
  stderrTail(): string;
}

export interface JobSandbox {
  start(): Promise<void>;
  /**
   * Clones the repository and returns the commit it starts from, read before the agent runs. A
   * `token` (a read-only one, for a private repository) reaches git only by name, for that clone.
   */
  clone(repoUrl: string, branch: string, signal: AbortSignal, token?: string): Promise<string>;
  startAgent(agent: AgentId, env: AgentEnv): AgentProcess;
  /**
   * Lists what the job added, changed or removed since `baseCommit` (commits the agent made
   * included) into `CONTAINER_CHANGES_LIST` (`git diff --raw -z`), and writes the changes as a
   * patch to `CONTAINER_PATCH_FILE`. Both are read only after `destroy`. Git runs inside the
   * container, never on the host: the agent could have written the repository's git config and hooks.
   */
  collectChanges(baseCommit: string): Promise<void>;
  /**
   * Stops everything the job started and removes its container. Throws a `SandboxError` when the
   * container is still there afterwards: nothing it wrote may be read then. Idempotent once it worked.
   */
  destroy(): Promise<void>;
}

export interface SandboxStatus {
  readonly ready: boolean;
  /** Why not, for the log. */
  readonly reason?: string;
}

export interface SandboxProvider {
  /** Whether jobs can start now. */
  status(): SandboxStatus;
  /** Gets ready (builds the job image when it is missing). Never throws. */
  prepare(signal: AbortSignal): Promise<SandboxStatus>;
  create(order: JobOrder, dirs: JobDirs): JobSandbox;
  /** Removes job containers a previous run of the service left behind. Returns how many. */
  removeLeftovers(): Promise<number>;
  /** The service is stopping: removes what jobs left and the egress proxy. Never throws. */
  shutdown?(): Promise<void>;
}

/**
 * How job containers reach the network. `proxy` (the default): an internal Docker network of this machine's, whose
 * only way out is the egress proxy (public addresses, ports 80 and 443): no LAN, no host, no cloud metadata. `open`
 * (`NEXUS_MACHINE_JOB_EGRESS=open`): Docker's default network, as before.
 */
export type EgressMode = "proxy" | "open";

export interface EgressNames {
  readonly network: string;
  readonly proxy: string;
}

export function egressNames(machineId: string): EgressNames {
  const short = machineId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "machine";
  return { network: `nexus-jobs-${short}`, proxy: `nexus-egress-${short}` };
}

/** What a job container gets so its tools use the proxy (curl, git, npm, pip, Codex, Claude, Node with the flag). */
export function proxyEnv(): Record<string, string> {
  const url = `http://${EGRESS_ALIAS}:${EGRESS_PORT}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
  };
}

export class SandboxError extends Error {}

const TAIL_LINES = 20;

function tail(lines: string[], chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    lines.push(line.slice(0, 500));
    if (lines.length > TAIL_LINES) lines.shift();
  }
}

/** The job image's tag: the service's version plus a hash of the build context, so a changed image is rebuilt. */
export function imageTag(contextDir: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).toSorted()) {
      const file = path.join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        hash.update(path.relative(contextDir, file));
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
      }
    }
  };
  walk(contextDir);
  return `${IMAGE_REPOSITORY}:${MACHINE_VERSION}-${hash.digest("hex").slice(0, 12)}`;
}

export interface DockerOptions {
  readonly machineId: string;
  /** `machine/job-image` as installed next to the bundle. */
  readonly contextDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
  readonly run?: CommandRunner;
  readonly spawn?: typeof spawn;
  readonly uid?: number;
  readonly gid?: number;
  /** `--memory` and `--cpus` for each job container (`NEXUS_MACHINE_JOB_MEMORY`, `NEXUS_MACHINE_JOB_CPUS`). */
  readonly memory?: string;
  readonly cpus?: string;
  /** `proxy` unless `NEXUS_MACHINE_JOB_EGRESS=open`. */
  readonly egress?: EgressMode;
  /** More ports the proxy allows besides 80 and 443 (`NEXUS_MACHINE_EGRESS_PORTS`, e.g. `22,8443`). */
  readonly egressPorts?: string;
}

/** The `docker run` arguments for a job's container. Exported for tests: it is where the isolation is. */
export function containerArgs(options: {
  readonly name: string;
  readonly image: string;
  readonly machineId: string;
  readonly jobId: string;
  readonly dirs: JobDirs;
  readonly uid: number;
  readonly gid: number;
  readonly memory?: string;
  readonly cpus?: string;
  /** The internal network to join (egress through the proxy only); left out, Docker's default network. */
  readonly network?: string;
}): string[] {
  const { dirs } = options;
  const network = options.network
    ? [
        "--network",
        options.network,
        ...Object.entries(proxyEnv()).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      ]
    : [];
  return [
    "run",
    "--detach",
    "--name",
    options.name,
    "--label",
    `${LABEL_MACHINE}=${options.machineId}`,
    "--label",
    `${LABEL_JOB}=${options.jobId}`,
    // The owner's uid, so the files it writes are theirs; no root, no capabilities, no setuid.
    "--user",
    `${options.uid}:${options.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "4096",
    ...(options.memory ? ["--memory", options.memory] : []),
    ...(options.cpus ? ["--cpus", options.cpus] : []),
    // Only the job's own folders. Never the docker socket, the owner's home or the service's config.
    "--mount",
    `type=bind,source=${dirs.work},target=${CONTAINER_WORK}`,
    "--mount",
    `type=bind,source=${dirs.home},target=${CONTAINER_HOME}`,
    "--mount",
    `type=bind,source=${dirs.out},target=${CONTAINER_OUT}`,
    "--env",
    `HOME=${CONTAINER_HOME}`,
    "--env",
    "GIT_TERMINAL_PROMPT=0",
    ...network,
    "--workdir",
    CONTAINER_WORK,
    options.image,
    "sleep",
    "infinity",
  ];
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly #options: DockerOptions;
  readonly #run: CommandRunner;
  #status: SandboxStatus = { ready: false, reason: "not checked yet" };
  #image: string | undefined;

  constructor(options: DockerOptions) {
    this.#options = options;
    this.#run = options.run ?? defaultCommandRunner;
  }

  status(): SandboxStatus {
    return this.#status;
  }

  async #docker(args: readonly string[], timeoutMs = SHORT_TIMEOUT_MS) {
    return this.#run("docker", args, { timeoutMs, env: this.#options.env });
  }

  async prepare(signal: AbortSignal): Promise<SandboxStatus> {
    const { log } = this.#options;
    let image: string;
    try {
      image = imageTag(this.#options.contextDir);
    } catch {
      this.#status = { ready: false, reason: `the job image's files are missing (${this.#options.contextDir})` };
      return this.#status;
    }
    const daemon = await this.#docker(["version", "--format", "{{.Server.Version}}"]);
    if (daemon.code !== 0) {
      this.#status = { ready: false, reason: "Docker is not running, or this user may not use it" };
      return this.#status;
    }
    const present = await this.#docker(["image", "inspect", "--format", "{{.Id}}", image]);
    if (present.code !== 0) {
      if (signal.aborted) return this.#status;
      log.info("machine-service: building the job image (first run; this takes a few minutes)", { image });
      const built = await this.#docker(["build", "--tag", image, this.#options.contextDir], BUILD_TIMEOUT_MS);
      if (built.code !== 0) {
        const lines: string[] = [];
        tail(lines, built.stderr || built.stdout);
        log.error("machine-service: could not build the job image", { image, output: lines.join("\n") });
        this.#status = { ready: false, reason: "the job image could not be built" };
        return this.#status;
      }
      log.info("machine-service: job image ready", { image });
    }
    this.#image = image;
    if (this.#egress === "proxy") {
      const reason = await this.#startEgress(image);
      if (reason) {
        this.#status = { ready: false, reason };
        return this.#status;
      }
    }
    this.#status = { ready: true };
    return this.#status;
  }

  get #egress(): EgressMode {
    return this.#options.egress ?? "proxy";
  }

  /** The machine's internal network and its egress proxy, (re)made when missing. A reason when it cannot. */
  async #startEgress(image: string): Promise<string | undefined> {
    const { network, proxy } = egressNames(this.#options.machineId);
    const label = `${LABEL_MACHINE}=${this.#options.machineId}`;
    const exists = await this.#docker(["network", "inspect", "--format", NETWORK_FORMAT, network]);
    if (exists.code !== 0) {
      // Internal (no route out) and with an isolated gateway (no address on the host's side), so a job reaches neither
      // the internet nor this computer except through the proxy. The isolated gateway needs Docker 28 or later.
      const made = await this.#docker([
        "network",
        "create",
        "--internal",
        "--opt",
        "com.docker.network.bridge.gateway_mode_ipv4=isolated",
        "--opt",
        "com.docker.network.bridge.gateway_mode_ipv6=isolated",
        "--label",
        label,
        network,
      ]);
      if (made.code !== 0) {
        return "the jobs' isolated Docker network could not be created (it needs Docker 28 or later)";
      }
    } else if (exists.stdout.trim() !== "true isolated") {
      return `the Docker network ${network} exists but is not internal and isolated; remove it and restart`;
    }
    const running = await this.#docker(["inspect", "--format", PROXY_FORMAT, proxy]);
    if (running.code === 0 && running.stdout.trim().startsWith(`true ${image} `)) {
      if (running.stdout.includes(` ${network} `)) return undefined;
      // Running, but not on the jobs' network (a connect that failed earlier): connect it now.
      const joined = await this.#docker(["network", "connect", "--alias", EGRESS_ALIAS, network, proxy]);
      return joined.code === 0 ? undefined : "the jobs' egress proxy could not join their network";
    }
    await this.#docker(["rm", "--force", proxy]);
    const started = await this.#docker([
      "run",
      "--detach",
      "--name",
      proxy,
      "--label",
      label,
      "--label",
      `${LABEL_EGRESS}=true`,
      "--user",
      "65534:65534",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--pids-limit",
      "256",
      "--memory",
      "256m",
      // Back after a Docker restart; its log (one line per refusal) cannot fill the disk.
      "--restart",
      "unless-stopped",
      "--log-opt",
      "max-size=10m",
      "--log-opt",
      "max-file=2",
      ...(this.#options.egressPorts && /^\d{1,5}(,\d{1,5})*$/.test(this.#options.egressPorts)
        ? ["--env", `NEXUS_EGRESS_PORTS=${this.#options.egressPorts}`]
        : []),
      image,
      "node",
      EGRESS_PROXY_SCRIPT,
    ]);
    if (started.code !== 0) return "the jobs' egress proxy could not be started";
    const joined = await this.#docker(["network", "connect", "--alias", EGRESS_ALIAS, network, proxy]);
    if (joined.code !== 0) return "the jobs' egress proxy could not join their network";
    this.#options.log.info("machine-service: job egress goes through the proxy (public addresses, ports 80 and 443)");
    return undefined;
  }

  async shutdown(): Promise<void> {
    await this.removeLeftovers().catch(() => 0);
    if (this.#egress !== "proxy") return;
    const { network, proxy } = egressNames(this.#options.machineId);
    await this.#docker(["rm", "--force", proxy]).catch(() => undefined);
    await this.#docker(["network", "rm", network]).catch(() => undefined);
  }

  async removeLeftovers(): Promise<number> {
    const listed = await this.#docker([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${LABEL_MACHINE}=${this.#options.machineId}`,
      // Job containers only: the egress proxy is kept, and remade by `prepare` when it is not right.
      "--filter",
      `label=${LABEL_JOB}`,
    ]);
    const ids = listed.code === 0 ? listed.stdout.split(/\s+/).filter(Boolean) : [];
    if (ids.length) await this.#docker(["rm", "--force", ...ids]);
    return ids.length;
  }

  create(order: JobOrder, dirs: JobDirs): JobSandbox {
    if (!this.#image) throw new SandboxError("The job image is not ready.");
    const image = this.#image;
    // Each job checks its way out first: the proxy may have stopped (a Docker restart) since `prepare`.
    const ensureEgress = async () => (this.#egress === "proxy" ? this.#startEgress(image) : undefined);
    return new DockerSandbox(this.#options, this.#run, image, order, dirs, ensureEgress);
  }
}

class DockerSandbox implements JobSandbox {
  readonly #options: DockerOptions;
  readonly #run: CommandRunner;
  readonly #image: string;
  readonly #order: JobOrder;
  readonly #dirs: JobDirs;
  readonly #name: string;
  #destroyed = false;
  readonly #children = new Set<ChildProcess>();

  readonly #ensureEgress: () => Promise<string | undefined>;

  constructor(
    options: DockerOptions,
    run: CommandRunner,
    image: string,
    order: JobOrder,
    dirs: JobDirs,
    ensureEgress: () => Promise<string | undefined>
  ) {
    this.#ensureEgress = ensureEgress;
    this.#options = options;
    this.#run = run;
    this.#image = image;
    this.#order = order;
    this.#dirs = dirs;
    this.#name = `nexus-job-${order.id}`;
  }

  #docker(args: readonly string[], timeoutMs = SHORT_TIMEOUT_MS, signal?: AbortSignal) {
    return this.#run("docker", args, { timeoutMs, env: this.#options.env, ...(signal ? { signal } : {}) });
  }

  async start(): Promise<void> {
    const egress = await this.#ensureEgress();
    if (egress) throw new SandboxError(`The job cannot reach the network: ${egress}.`);
    const args = containerArgs({
      name: this.#name,
      image: this.#image,
      machineId: this.#options.machineId,
      jobId: this.#order.id,
      dirs: this.#dirs,
      uid: this.#options.uid ?? process.getuid?.() ?? 1000,
      gid: this.#options.gid ?? process.getgid?.() ?? 1000,
      ...(this.#options.memory ? { memory: this.#options.memory } : {}),
      ...(this.#options.cpus ? { cpus: this.#options.cpus } : {}),
      ...((this.#options.egress ?? "proxy") === "proxy"
        ? { network: egressNames(this.#options.machineId).network }
        : {}),
    });
    const result = await this.#docker(args);
    if (result.code !== 0) {
      throw new SandboxError(`Could not start the job's container: ${firstLine(result.stderr) || "docker failed"}.`);
    }
  }

  async clone(repoUrl: string, branch: string, signal: AbortSignal, token?: string): Promise<string> {
    if (signal.aborted) throw new SandboxError("Stopped before the repository was cloned.");
    // A token goes to git as an extra header for the repository's own host only, through variables passed by name:
    // never on a command line, never in the clone's git config.
    const access = token ? cloneAccess(repoUrl, token) : undefined;
    const result = await this.#run(
      "docker",
      [
        "exec",
        ...(access ? Object.keys(access).flatMap((name) => ["--env", name]) : []),
        this.#name,
        "git",
        // https only, whatever the repository's submodules or redirects ask for.
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "clone",
        "--depth",
        "50",
        "--single-branch",
        "--branch",
        branch,
        "--",
        repoUrl,
        CONTAINER_REPO,
      ],
      { timeoutMs: CLONE_TIMEOUT_MS, env: { ...this.#options.env, ...access }, signal }
    );
    if (result.code !== 0) {
      const hint = token
        ? ""
        : " A private repository needs the CRM's GitHub App installed on it, so the job gets read access.";
      throw new SandboxError(`Could not clone the repository (${firstLine(result.stderr) || "git failed"}).${hint}`);
    }
    const head = await this.#docker([
      "exec",
      this.#name,
      "git",
      "-c",
      "core.fsmonitor=false",
      "-C",
      CONTAINER_REPO,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    const base = head.stdout.trim();
    if (head.code !== 0 || !isCommit(base)) throw new SandboxError("Could not read the cloned repository's commit.");
    return base;
  }

  startAgent(agent: AgentId, env: AgentEnv): AgentProcess {
    const args = ["exec", "--interactive", "--workdir", CONTAINER_REPO];
    for (const [name, value] of Object.entries(env.plain)) args.push("--env", `${name}=${value}`);
    // `--env NAME` without a value: docker takes the value from its own environment, set below.
    for (const name of Object.keys(env.secret)) args.push("--env", name);
    args.push(this.#name, "node", ADAPTER_BIN[agent]);
    const child = (this.#options.spawn ?? spawn)("docker", args, {
      env: { ...this.#options.env, ...env.secret },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#children.add(child);
    const lines: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => tail(lines, chunk));
    child.stdin?.on("error", () => undefined);
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", (code) => {
        this.#children.delete(child);
        resolve(code);
      });
    });
    return { stdin: child.stdin!, stdout: child.stdout!, exited, stderrTail: () => lines.join("\n") };
  }

  async collectChanges(baseCommit: string): Promise<void> {
    if (!isCommit(baseCommit)) return;
    // A fixed script; the only value in it is the commit the machine itself read after the clone. Untracked files are
    // added as intent-to-add so the diff shows them (a lock the agent left would stop that, so it goes); the diff is
    // against that commit, so commits the agent made count. Both go to files, read once the container is gone.
    const git = "git -c core.fsmonitor=false -c core.hooksPath=/dev/null";
    await this.#docker([
      "exec",
      this.#name,
      "sh",
      "-c",
      `cd ${CONTAINER_REPO} && rm -f ${CONTAINER_PATCH_FILE} ${CONTAINER_CHANGES_LIST} .git/index.lock && ` +
        `${git} add --all --intent-to-add . >/dev/null 2>&1; ` +
        `${git} diff --raw -z --no-renames --no-abbrev --no-ext-diff ${baseCommit} > ${CONTAINER_CHANGES_LIST}; ` +
        `${git} diff --binary --no-ext-diff --no-textconv --no-color ${baseCommit} > ${CONTAINER_PATCH_FILE}`,
    ]);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    // Removing the container ends everything in it, the agent included; the `docker exec` clients then exit.
    await this.#docker(["rm", "--force", this.#name]);
    for (const child of this.#children) child.kill("SIGKILL");
    // Only a container that is really gone lets the service read what it wrote.
    const still = await this.#docker(["inspect", "--format", "{{.Id}}", this.#name]);
    if (still.code === 0) {
      throw new SandboxError("Could not remove the job's container, so nothing it wrote was read.");
    }
    this.#destroyed = true;
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 300);
}

/** The variables that give git a read token for `repoUrl`'s host, for one command. */
export function cloneAccess(repoUrl: string, token: string): Record<string, string> {
  const origin = new URL(repoUrl).origin;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}
