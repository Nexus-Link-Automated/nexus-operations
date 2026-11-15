/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { expect } from "vitest";

import type { Logger } from "../src/logger.ts";
import type { CommandResult, CommandRunner, MachineFs } from "../src/machine/system.ts";

/** A computer with exactly these executables and files. */
export function fakeFs(options: { executables?: readonly string[]; files?: Record<string, string> } = {}): MachineFs {
  const executables = new Set(options.executables ?? []);
  const files = options.files ?? {};
  return {
    readText: (file) => (Object.hasOwn(files, file) ? files[file] : undefined),
    isExecutable: (file) => executables.has(file),
  };
}

/** Answers `<bin name> <args>` from the table; anything else "cannot start" (code null). Records every call. */
export function fakeRunner(table: Record<string, Partial<CommandResult>>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner = async (file: string, args: readonly string[]) => {
    const key = [path.basename(file), ...args].join(" ");
    calls.push(key);
    const answer = table[key];
    return answer ? { code: 0, stdout: "", stderr: "", ...answer } : { code: null, stdout: "", stderr: "" };
  };
  return Object.assign(runner, { calls });
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: unknown;
}

export interface FakeAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A stand-in for the CRM's machine endpoints: answers each request with `respond`. */
export class FakeCrm {
  readonly requests: RecordedRequest[] = [];
  respond: (request: RecordedRequest) => FakeAnswer = () => ({ status: 500 });
  #server: Server | undefined;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen(port = 0): Promise<void> {
    const server = createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.#server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const request = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      this.requests.push(request);
      const answer = this.respond(request);
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
    });
  }
}

export function heartbeatOk(state = "active", heartbeatSeconds = 15): FakeAnswer {
  return {
    status: 200,
    body: { machine_id: "m-1", name: "Laptop", state, heartbeat_seconds: heartbeatSeconds, jobs: [] },
  };
}

/** Logs into an array, for asserting what was (and was not) logged. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    lines.push(`${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  };
  return { lines, debug: add("debug"), info: add("info"), warn: add("warn"), error: add("error") };
}

/**
 * Checks `value` against the CRM's strict heartbeat schema (`apps/api/plane/coding/serializers/
 * machine.py` `HeartbeatSerializer`): exactly these keys, these types, these bounds.
 */
export function expectStrictHeartbeat(value: unknown): void {
  const body = value as Record<string, unknown>;
  expect(Object.keys(body).toSorted()).toEqual(
    "capabilities" in body ? ["capabilities", "hostname", "os", "version"] : ["hostname", "os", "version"]
  );
  expectString(body.hostname, 255);
  expectString(body.os, 64);
  expectString(body.version, 32);
  if (!("capabilities" in body)) return;
  const caps = body.capabilities as Record<string, unknown>;
  expect(Object.keys(caps).toSorted()).toEqual(["agents", "docker", "slots", "toolchains"]);
  const agents = caps.agents as Record<string, unknown>[];
  expect(Array.isArray(agents) && agents.length <= 2).toBe(true);
  for (const agent of agents) {
    expect(Object.keys(agent).toSorted()).toEqual(["id", "installed", "signed_in", "version"]);
    expect(["codex", "claude"]).toContain(agent.id);
    expect(typeof agent.installed).toBe("boolean");
    expect(typeof agent.signed_in).toBe("boolean");
    if (agent.version !== null) expectString(agent.version, 64);
  }
  const toolchains = caps.toolchains as Record<string, unknown>[];
  expect(Array.isArray(toolchains) && toolchains.length <= 30).toBe(true);
  for (const toolchain of toolchains) {
    expect(Object.keys(toolchain).toSorted()).toEqual(["name", "version"]);
    expectString(toolchain.name, 32);
    expect((toolchain.name as string).length).toBeGreaterThan(0);
    expectString(toolchain.version, 64);
  }
  const docker = caps.docker as Record<string, unknown>;
  expect(Object.keys(docker).toSorted()).toEqual(["available", "version"]);
  expect(typeof docker.available).toBe("boolean");
  if (docker.version !== null) expectString(docker.version, 64);
  const slots = caps.slots as Record<string, unknown>;
  expect(Object.keys(slots).toSorted()).toEqual(["free", "total"]);
  for (const count of [slots.total, slots.free]) {
    expect(Number.isInteger(count) && (count as number) >= 0 && (count as number) <= 32).toBe(true);
  }
  expect(slots.free as number).toBeLessThanOrEqual(slots.total as number);
}

function expectString(value: unknown, max: number): void {
  expect(typeof value).toBe("string");
  expect(Array.from(value as string).length).toBeLessThanOrEqual(max);
}
