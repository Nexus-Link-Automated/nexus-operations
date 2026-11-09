/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- requests run one after another against a local fake */
import { spawn, type SpawnOptions } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adapterBinPaths, type AgentCommand } from "../src/bins.ts";
import { loadRunnerConfig } from "../src/config.ts";
import { CredentialBroker } from "../src/credential-broker.ts";
import { buildAgentEnv, isReservedEnvName } from "../src/env.ts";
import { silentLogger, type Logger } from "../src/logger.ts";
import type { AgentRunner } from "../src/server.ts";
import {
  SECRET,
  USER_ID,
  WORKSPACE_ID,
  acpClient,
  startRunner,
  tempRoot,
  textOf,
  ticket,
  upgradeStatus,
  waitUntil,
} from "./helpers.ts";

const REAL_KEY = "sk-real-provider-key-0123456789";

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface FakeServer {
  readonly server: Server;
  readonly origin: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

const servers: FakeServer[] = [];

/** A local stand-in for a provider that records every request it gets. */
async function fakeUpstream(handler?: RequestListener): Promise<FakeServer> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (handler) return void handler(req, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeServer = {
    server,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

/** A promise the test resolves when it is ready for the fake to go on. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function chatDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

const brokers: CredentialBroker[] = [];

async function startBroker(upstreams: Record<string, string>, log: Logger = silentLogger): Promise<CredentialBroker> {
  const broker = new CredentialBroker({ log, upstreams });
  await broker.listen();
  brokers.push(broker);
  return broker;
}

let runner: AgentRunner | undefined;

afterEach(async () => {
  await runner?.close();
  runner = undefined;
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Each vendor's key variable, base URL setting, and the auth scheme its client really uses. */
const VENDORS = [
  {
    adapter: "claude",
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    path: "/v1/messages",
    upstreamPath: "/v1/messages",
    authHeader: "x-api-key",
    send: (token: string) => token,
    expected: REAL_KEY,
  },
  {
    adapter: "codex",
    keyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "PLANE_CODEX_BASE_URL",
    path: "/responses",
    upstreamPath: "/v1/responses",
    authHeader: "authorization",
    send: (token: string) => `Bearer ${token}`,
    expected: `Bearer ${REAL_KEY}`,
  },
  {
    adapter: "gemini",
    keyEnv: "GEMINI_API_KEY",
    baseUrlEnv: "GOOGLE_GEMINI_BASE_URL",
    path: "/v1beta/models/gemini-pro:streamGenerateContent?alt=sse",
    upstreamPath: "/v1beta/models/gemini-pro:streamGenerateContent?alt=sse",
    authHeader: "x-goog-api-key",
    send: (token: string) => token,
    expected: REAL_KEY,
  },
  {
    adapter: "deepseek",
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    path: "/chat/completions",
    upstreamPath: "/chat/completions",
    authHeader: "authorization",
    send: (token: string) => `Bearer ${token}`,
    expected: `Bearer ${REAL_KEY}`,
  },
] as const;

const claude = VENDORS[0];

/** Starts a brokered agent for `vendor` against `upstream`. */
async function brokeredAgent(vendor: (typeof VENDORS)[number], upstream: string, log?: Logger) {
  const broker = await startBroker({ [vendor.adapter]: upstream }, log);
  const brokered = broker.broker(vendor.adapter, { [vendor.keyEnv]: REAL_KEY, PLANE_AGENT_MODEL: "m" });
  const token = brokered.env[vendor.keyEnv]!;
  const base = brokered.env[vendor.baseUrlEnv]!;
  return { broker, brokered, token, base, url: `${base}${vendor.path}` };
}

function authHeaders(vendor: (typeof VENDORS)[number], token: string): Record<string, string> {
  return { [vendor.authHeader]: vendor.send(token) };
}

describe("token swap", () => {
  for (const vendor of VENDORS) {
    it(`replaces the token with the real key for ${vendor.adapter}`, async () => {
      const upstream = await fakeUpstream();
      const { token, brokered, url } = await brokeredAgent(vendor, upstream.origin);

      expect(token).not.toContain(REAL_KEY);
      expect(Object.values(brokered.env).join("\n")).not.toContain(REAL_KEY);

      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(vendor, token) },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      expect(upstream.seen).toHaveLength(1);
      const [request] = upstream.seen;
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe(vendor.upstreamPath);
      expect(request?.body).toBe('{"hello":"world"}');
      expect(request?.headers[vendor.authHeader]).toBe(vendor.expected);
      expect(request?.headers.host).toBe(new URL(upstream.origin).host);
      expect(JSON.stringify(request?.headers)).not.toContain(token);
    });
  }

  it("removes every other credential header the agent sends", async () => {
    const upstream = await fakeUpstream();
    const { token, url } = await brokeredAgent(claude, upstream.origin);
    await fetch(url, {
      headers: { "x-api-key": token, authorization: "Bearer attacker", "x-goog-api-key": "attacker" },
    });
    expect(upstream.seen[0]?.headers["x-api-key"]).toBe(REAL_KEY);
    expect(upstream.seen[0]?.headers.authorization).toBeUndefined();
    expect(upstream.seen[0]?.headers["x-goog-api-key"]).toBeUndefined();
  });
});

describe("access", () => {
  it("refuses a missing or unknown token and never reaches the provider", async () => {
    const upstream = await fakeUpstream();
    const { url } = await brokeredAgent(claude, upstream.origin);

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { "x-api-key": "pab_nope" } })).status).toBe(401);
    expect((await fetch(url, { headers: { "x-api-key": REAL_KEY } })).status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it("accepts a token only in its own vendor's auth header", async () => {
    const upstream = await fakeUpstream();
    const { token, url } = await brokeredAgent(claude, upstream.origin);
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it("gives every agent its own token", async () => {
    const upstream = await fakeUpstream();
    const broker = await startBroker({ claude: upstream.origin, deepseek: upstream.origin });
    const a = broker.broker("claude", { ANTHROPIC_API_KEY: "key-a" }).env.ANTHROPIC_API_KEY;
    const b = broker.broker("claude", { ANTHROPIC_API_KEY: "key-a" }).env.ANTHROPIC_API_KEY;
    expect(a).not.toBe(b);
  });

  it("kills the token and any open stream when the agent exits", async () => {
    let upstreamClosed = false;
    const upstream = await fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.on("close", () => {
        upstreamClosed = true;
      });
    });
    const { token, brokered, url } = await brokeredAgent(claude, upstream.origin);

    const response = await fetch(url, { headers: { "x-api-key": token } });
    const reader = response.body!.getReader();
    await reader.read();

    brokered.revoke();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      })()
    ).rejects.toThrow();
    await waitUntil(() => upstreamClosed);

    expect((await fetch(url, { headers: { "x-api-key": token } })).status).toBe(401);
    brokered.revoke();
  });
});

describe("the agent cannot choose the upstream", () => {
  async function setup() {
    const fixed = await fakeUpstream();
    const other = await fakeUpstream();
    const agent = await brokeredAgent(claude, fixed.origin);
    return { fixed, other, ...agent };
  }

  /** Sends raw request bytes and resolves with the status line. */
  function rawRequest(base: string, bytes: string): Promise<string> {
    const { hostname, port } = new URL(base);
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), hostname, () => socket.write(bytes));
      let answer = "";
      socket.on("data", (chunk) => {
        answer += chunk.toString("utf8");
        if (answer.includes("\r\n")) {
          socket.destroy();
          resolve(answer.slice(0, answer.indexOf("\r\n")));
        }
      });
      socket.on("error", reject);
    });
  }

  it("ignores Host and X-Forwarded-Host", async () => {
    const { fixed, other, token, base } = await setup();
    const status = await rawRequest(
      base,
      `GET /v1/models HTTP/1.1\r\nHost: ${new URL(other.origin).host}\r\nX-Forwarded-Host: ${new URL(other.origin).host}\r\nx-api-key: ${token}\r\nConnection: close\r\n\r\n`
    );
    expect(status).toContain("200");
    await waitUntil(() => fixed.seen.length === 1);
    expect(fixed.seen[0]?.headers.host).toBe(new URL(fixed.origin).host);
    expect(other.seen).toHaveLength(0);
  });

  it("refuses absolute-form and scheme-relative request targets", async () => {
    const { fixed, other, token, base } = await setup();
    for (const target of [`${other.origin}/v1/models`, `//${new URL(other.origin).host}/v1/models`, "*"]) {
      const status = await rawRequest(
        base,
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-api-key: ${token}\r\nConnection: close\r\n\r\n`
      );
      expect(status, target).toContain("400");
    }
    expect(fixed.seen).toHaveLength(0);
    expect(other.seen).toHaveLength(0);
  });

  it("does not follow a redirect from the provider", async () => {
    const other = await fakeUpstream();
    const fixed = await fakeUpstream((_req, res) => {
      res.writeHead(302, { location: `${other.origin}/stolen` });
      res.end();
    });
    const { token, url } = await brokeredAgent(claude, fixed.origin);
    const response = await fetch(url, { headers: { "x-api-key": token }, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(other.seen).toHaveLength(0);
  });
});

describe("streaming", () => {
  it("passes a response through chunk by chunk", async () => {
    const gate = deferred();
    const upstream = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      await gate.promise;
      res.write("data: two\n\n");
      res.end();
    });
    const { token, url } = await brokeredAgent(claude, upstream.origin);

    const response = await fetch(url, { headers: { "x-api-key": token } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // The first chunk must arrive while the provider is still holding back the second.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: one\n\n");

    gate.resolve();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    expect(rest).toBe("data: two\n\n");
  });

  it("delivers a slow stream's headers before its first byte", async () => {
    const gate = deferred();
    const upstream = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      await gate.promise;
      res.end("data: late\n\n");
    });
    const { token, url } = await brokeredAgent(claude, upstream.origin);

    const response = await fetch(url, { headers: { "x-api-key": token } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await waitUntil(() => upstream.seen.length === 1);
    gate.resolve();
    expect(await response.text()).toBe("data: late\n\n");
  });

  it("answers 502 when the provider cannot be reached", async () => {
    const dead = await fakeUpstream();
    const { token, url } = await brokeredAgent(claude, dead.origin);
    await dead.close();
    expect((await fetch(url, { headers: { "x-api-key": token } })).status).toBe(502);
  });
});

describe("WebSocket upgrades", () => {
  async function wsUpstream() {
    const http = await fakeUpstream();
    const wss = new WebSocketServer({ noServer: true });
    const handshakes: IncomingHttpHeaders[] = [];
    http.server.on("upgrade", (req, socket, head) => {
      handshakes.push(req.headers);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data: Buffer) => ws.send(`echo:${data.toString()}`));
      });
    });
    return { http, wss, handshakes };
  }

  const codex = VENDORS[1];

  function open(url: string, token: string): WebSocket {
    return new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  }

  it("swaps the token in the handshake and relays frames both ways", async () => {
    const upstream = await wsUpstream();
    const { token, base } = await brokeredAgent(codex, upstream.http.origin);

    const socket = open(`${base.replace(/^http/, "ws")}/responses`, token);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const reply = new Promise<string>((resolve) => socket.once("message", (data: Buffer) => resolve(data.toString())));
    socket.send("ping");
    expect(await reply).toBe("echo:ping");
    socket.close();

    expect(upstream.handshakes).toHaveLength(1);
    expect(upstream.handshakes[0]?.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(JSON.stringify(upstream.handshakes[0])).not.toContain(token);
  });

  it("refuses a bad token and closes the socket on revoke", async () => {
    const upstream = await wsUpstream();
    const { token, base, brokered } = await brokeredAgent(codex, upstream.http.origin);
    const url = `${base.replace(/^http/, "ws")}/responses`;

    expect(await upgradeStatus(url, { authorization: "Bearer nope" })).toBe(401);

    const socket = open(url, token);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    brokered.revoke();
    await closed;
    expect(await upgradeStatus(url, { authorization: `Bearer ${token}` })).toBe(401);
  });

  it("relays the provider's refusal of the upgrade", async () => {
    const http = await fakeUpstream();
    http.server.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const { token, base } = await brokeredAgent(codex, http.origin);
    expect(await upgradeStatus(`${base.replace(/^http/, "ws")}/responses`, { authorization: `Bearer ${token}` })).toBe(
      426
    );
  });
});

describe("logging", () => {
  it("logs neither keys, tokens nor headers", async () => {
    const lines: string[] = [];
    const log: Logger = {
      debug: (message, meta) => lines.push(`${message} ${JSON.stringify(meta)}`),
      info: (message, meta) => lines.push(`${message} ${JSON.stringify(meta)}`),
      warn: (message, meta) => lines.push(`${message} ${JSON.stringify(meta)}`),
      error: (message, meta) => lines.push(`${message} ${JSON.stringify(meta)}`),
    };
    const dead = await fakeUpstream();
    const { token, url } = await brokeredAgent(claude, dead.origin, log);
    await dead.close();

    await fetch(url, { headers: { "x-api-key": token } });
    await fetch(url, { headers: { "x-api-key": "pab_nope" } });

    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).not.toContain(REAL_KEY);
    expect(output).not.toContain(token);
    expect(output).not.toContain("pab_nope");
  });
});

describe("which env gets brokered", () => {
  let broker: CredentialBroker;
  beforeEach(async () => {
    broker = await startBroker({});
  });

  for (const vendor of VENDORS) {
    it(`takes ${vendor.adapter}'s key out of the env and points it at the broker`, () => {
      const { env, leftDirectBecause } = broker.broker(vendor.adapter, { [vendor.keyEnv]: REAL_KEY });
      expect(leftDirectBecause).toBeUndefined();
      expect(env[vendor.keyEnv]).toMatch(/^pab_[0-9a-f]{64}$/);
      expect(env[vendor.baseUrlEnv]).toMatch(/^http:\/\/127\.0\.0\.1:\d+(\/v1)?$/);
      expect(Object.values(env).join("\n")).not.toContain(REAL_KEY);
    });
  }

  it("tells Claude Code the broker is the first-party API", () => {
    expect(broker.broker("claude", { ANTHROPIC_API_KEY: REAL_KEY }).env).toMatchObject({
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    });
  });

  it("marks a Claude env as brokered only when the key really was", () => {
    expect(broker.broker("claude", { ANTHROPIC_API_KEY: REAL_KEY }).env.PLANE_CLAUDE_BROKERED).toBe("1");
    expect(
      broker.broker("claude", { ANTHROPIC_API_KEY: REAL_KEY, CLAUDE_CODE_OAUTH_TOKEN: "t" }).env.PLANE_CLAUDE_BROKERED
    ).toBeUndefined();
    expect(broker.broker("claude", { CLAUDE_CODE_OAUTH_TOKEN: "t" }).env.PLANE_CLAUDE_BROKERED).toBeUndefined();
    expect(broker.broker("deepseek", { DEEPSEEK_API_KEY: REAL_KEY }).env.PLANE_CLAUDE_BROKERED).toBeUndefined();
  });

  it("leaves an agent without a key, and other adapters, untouched", () => {
    const env = { PLANE_AGENT_MODEL: "m" };
    expect(broker.broker("claude", env).env).toBe(env);
    expect(broker.broker("echo", { ANTHROPIC_API_KEY: REAL_KEY }).env.ANTHROPIC_API_KEY).toBe(REAL_KEY);
  });

  it("does not broker a key the admin routes elsewhere, and says why", () => {
    for (const [adapter, env, blocker] of [
      ["claude", { ANTHROPIC_API_KEY: REAL_KEY, ANTHROPIC_BASE_URL: "https://gateway" }, "ANTHROPIC_BASE_URL"],
      ["claude", { ANTHROPIC_API_KEY: REAL_KEY, CLAUDE_CODE_OAUTH_TOKEN: "t" }, "CLAUDE_CODE_OAUTH_TOKEN"],
      ["claude", { ANTHROPIC_API_KEY: REAL_KEY, ANTHROPIC_AUTH_TOKEN: "t" }, "ANTHROPIC_AUTH_TOKEN"],
      ["gemini", { GEMINI_API_KEY: REAL_KEY, GOOGLE_GEMINI_BASE_URL: "https://gw" }, "GOOGLE_GEMINI_BASE_URL"],
      ["deepseek", { DEEPSEEK_API_KEY: REAL_KEY, DEEPSEEK_BASE_URL: "https://gw" }, "DEEPSEEK_BASE_URL"],
      ["codex", { OPENAI_API_KEY: REAL_KEY, HTTPS_PROXY: "http://proxy" }, "HTTPS_PROXY"],
    ] as const) {
      const result = broker.broker(adapter, env);
      expect(result.env, blocker).toEqual(env);
      expect(result.leftDirectBecause, blocker).toBe(blocker);
    }
  });

  it("drops a stray key when the agent signs in with an account", () => {
    const codex = broker.broker("codex", { OPENAI_API_KEY: REAL_KEY, PLANE_AGENT_AUTH: "chatgpt" }).env;
    expect(codex).toEqual({ PLANE_AGENT_AUTH: "chatgpt" });
    const gemini = broker.broker("gemini", { GEMINI_API_KEY: REAL_KEY, PLANE_AGENT_AUTH: "google_account" }).env;
    expect(gemini).toEqual({ PLANE_AGENT_AUTH: "google_account" });
  });

  it("does not let the admin env set the names only the broker may set", () => {
    expect(isReservedEnvName("PLANE_CODEX_BASE_URL")).toBe(true);
    expect(isReservedEnvName("PLANE_CLAUDE_BROKERED")).toBe(true);
  });
});

describe("the flag", () => {
  it("defaults to off", () => {
    expect(loadRunnerConfig({ AGENT_RUNNER_SECRET: SECRET }).credentialBroker).toBe(false);
    expect(
      loadRunnerConfig({ AGENT_RUNNER_SECRET: SECRET, AGENT_RUNNER_CREDENTIAL_BROKER: "true" }).credentialBroker
    ).toBe(true);
  });

  /** Starts the agent for a ticket and returns the env it was spawned with. */
  async function spawnedEnv(
    credentialBroker: boolean,
    upstream: string,
    adapter = "claude",
    env: Record<string, string> = { ANTHROPIC_API_KEY: REAL_KEY }
  ) {
    const root = tempRoot();
    const spawned: SpawnOptions[] = [];
    const started = await startRunner(root, {
      config: { credentialBroker },
      brokerUpstreams: { [adapter]: upstream },
      resolveCommand: (): AgentCommand => ({
        adapter: "echo",
        command: process.execPath,
        args: [adapterBinPaths().echo!],
      }),
      spawner: (command, args, options) => {
        spawned.push(options);
        return spawn(command, args, options);
      },
    });
    runner = started.runner;
    const client = acpClient(started.url, { Authorization: `Bearer ${ticket({ adapter, env })}` });
    await client.agent.request("initialize", { protocolVersion: 1 });
    await waitUntil(() => spawned.length === 1);
    return { env: spawned[0]!.env as Record<string, string>, client, root };
  }

  it("spawns the agent with no real key when it is on, and revokes the token on exit", async () => {
    const upstream = await fakeUpstream();
    const { env, client } = await spawnedEnv(true, upstream.origin);

    expect(Object.values(env).join("\n")).not.toContain(REAL_KEY);
    expect(env.ANTHROPIC_API_KEY).toMatch(/^pab_/);
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const response = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      headers: { "x-api-key": env.ANTHROPIC_API_KEY! },
    });
    expect(response.status).toBe(200);
    expect(upstream.seen[0]?.headers["x-api-key"]).toBe(REAL_KEY);

    client.close();
    await waitUntil(() => runner?.agents().length === 0);
    const after = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      headers: { "x-api-key": env.ANTHROPIC_API_KEY! },
    });
    expect(after.status).toBe(401);
  });

  it("changes nothing when it is off", async () => {
    const upstream = await fakeUpstream();
    const { env, root } = await spawnedEnv(false, upstream.origin);
    const expected = buildAgentEnv({
      agentEnv: { ANTHROPIC_API_KEY: REAL_KEY },
      layout: {
        cwd: `${root}/${WORKSPACE_ID}/${USER_ID}`,
        home: `${root}/.homes/${WORKSPACE_ID}/${USER_ID}`,
        tmp: `${root}/.tmp/${WORKSPACE_ID}/${USER_ID}`,
      },
      initialMode: "ask_writes",
      path: env.PATH!,
      shell: env.SHELL!,
    }).env;
    expect(env).toEqual(expected);
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("carries a real adapter's streamed turn end to end", async () => {
    const upstream = await fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatDelta("hello "));
      res.write(chatDelta("world"));
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
      );
    });
    const root = tempRoot();
    const spawned: SpawnOptions[] = [];
    const started = await startRunner(root, {
      config: { credentialBroker: true },
      brokerUpstreams: { deepseek: upstream.origin },
      resolveCommand: (): AgentCommand => ({
        adapter: "deepseek",
        command: process.execPath,
        args: [adapterBinPaths().deepseek!],
      }),
      spawner: (command, args, options) => {
        spawned.push(options);
        return spawn(command, args, options);
      },
    });
    runner = started.runner;

    const client = acpClient(started.url, {
      Authorization: `Bearer ${ticket({ adapter: "deepseek", env: { DEEPSEEK_API_KEY: REAL_KEY } })}`,
    });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const cwd = `${root}/${WORKSPACE_ID}/${USER_ID}`;
    const session = await client.agent.request("session/new", { cwd, mcpServers: [] });
    await client.agent.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(textOf(client.updates)).toBe("hello world");
    expect(Object.values(spawned[0]!.env as Record<string, string>).join("\n")).not.toContain(REAL_KEY);
    expect(upstream.seen[0]?.url).toBe("/chat/completions");
    expect(upstream.seen[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    client.close();
  });
});
