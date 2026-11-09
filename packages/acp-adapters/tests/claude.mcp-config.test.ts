/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { query as sdkQuery, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeAdapter } from "../src/claude/index.ts";
import { inProcessClient, tempDir, type InProcessClient } from "./helpers/client.ts";
import { fakeClaudeExecutable } from "./helpers/claude.ts";

const TOKEN = "plane-session-token-value";
const planeMcp: McpServer = {
  type: "http",
  name: "plane",
  url: "http://mcp.internal/mcp",
  headers: [
    { name: "Authorization", value: `Bearer ${TOKEN}` },
    { name: "X-Workspace-slug", value: "acme" },
  ],
};

const configFiles = (home: string) => {
  const dir = path.join(home, ".plane-acp");
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("Claude MCP servers, through the real Agent SDK", () => {
  let client: InProcessClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  function connect() {
    const fake = fakeClaudeExecutable();
    const query = ((params: Parameters<typeof sdkQuery>[0]) =>
      sdkQuery({
        ...params,
        options: { ...params.options, pathToClaudeCodeExecutable: fake.executable },
      })) as typeof sdkQuery;
    const connected = inProcessClient(createClaudeAdapter({ query }), fake.env);
    client = connected;
    return { fake, client: connected };
  }

  const open = async (connected: InProcessClient, mcpServers: McpServer[]) => {
    await connected.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await connected.agent.request("session/new", { cwd: tempDir(), mcpServers });
    return (text: string) => connected.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  };

  it("keeps the token off the command line and in a file only the agent's uid can read", async () => {
    const { fake, client: connected } = connect();
    const prompt = await open(connected, [planeMcp]);
    await prompt("hello");
    await prompt("hello again");

    const starts = fake.starts();
    expect(starts).toHaveLength(2);
    const paths = new Set<string>();
    for (const { cmdline, mcpConfig } of starts) {
      expect(cmdline.join(" ")).not.toContain(TOKEN);
      expect(cmdline.join(" ")).not.toContain("Bearer");
      expect(cmdline[cmdline.indexOf("--mcp-config") + 1]).toBe(mcpConfig?.path);
      expect(path.dirname(mcpConfig?.path ?? "")).toBe(path.join(fake.home, ".plane-acp"));
      expect(mcpConfig?.mode).toBe(0o600);
      expect(mcpConfig?.content).toEqual({
        mcpServers: {
          plane: {
            type: "http",
            url: "http://mcp.internal/mcp",
            headers: { Authorization: `Bearer ${TOKEN}`, "X-Workspace-slug": "acme" },
          },
        },
      });
      paths.add(mcpConfig?.path ?? "");
    }
    expect(paths.size).toBe(2);
    expect(configFiles(fake.home)).toEqual([]);
  });

  it("writes no file and passes no flag when the session has no MCP servers", async () => {
    const { fake, client: connected } = connect();
    const prompt = await open(connected, []);
    await prompt("hello");
    expect(fake.starts()[0]?.cmdline).not.toContain("--mcp-config");
    expect(existsSync(path.join(fake.home, ".plane-acp"))).toBe(false);
  });

  it("removes the file when the session closes before the CLI has started", async () => {
    const { fake, client: connected } = connect();
    const prompt = await open(connected, [planeMcp]);
    const turn = prompt("hang");
    turn.catch(() => {});
    await connected.waitFor(() => fake.starts().length === 1);
    expect(configFiles(fake.home)).toHaveLength(1);
    await connected.close();
    client = undefined;
    expect(configFiles(fake.home)).toEqual([]);
  });
});

describe("Claude MCP config cleanup", () => {
  let client: InProcessClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  const init = { type: "system", subtype: "init", session_id: "s" } as unknown as SDKMessage;
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    usage: {},
    modelUsage: {},
    total_cost_usd: 0,
  } as unknown as SDKMessage;

  function run(query: (options: Options) => AsyncGenerator<SDKMessage, void>) {
    const home = tempDir("claude-home-");
    const adapter = createClaudeAdapter({
      query: (({ options }: { options: Options }) => {
        const generator = query(options);
        return Object.assign(generator, { close: () => {} }) as unknown as Query;
      }) as never,
    });
    const connected = inProcessClient(adapter, { ANTHROPIC_API_KEY: "sk-ant-test", HOME: home });
    client = connected;
    const start = async () => {
      await connected.agent.request("initialize", { protocolVersion: 1 });
      const { sessionId } = await connected.agent.request("session/new", {
        cwd: tempDir(),
        mcpServers: [planeMcp],
      });
      return connected.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
    };
    return { home, start };
  }

  it("removes the file once the CLI reports it has started, before the turn goes on", async () => {
    const seen: number[] = [];
    const { home, start } = run(async function* () {
      seen.push(configFiles(home).length);
      yield init;
      // The adapter has handled `init` by the time the generator is resumed.
      seen.push(configFiles(home).length);
      yield result;
    });
    await start();
    expect(seen).toEqual([1, 0]);
  });

  it("removes the file when the turn fails before the CLI has started", async () => {
    const seen: number[] = [];
    const { home, start } = run(async function* () {
      seen.push(configFiles(home).length);
      yield* [];
      throw new Error("the CLI could not start");
    });
    await expect(start()).rejects.toThrow();
    expect(seen).toEqual([1]);
    expect(configFiles(home)).toEqual([]);
  });

  it("removes the file when query() itself throws", async () => {
    const seen: number[] = [];
    const { home, start } = run(() => {
      seen.push(configFiles(home).length);
      throw new Error("no CLI binary");
    });
    await expect(start()).rejects.toThrow();
    expect(seen).toEqual([1]);
    expect(configFiles(home)).toEqual([]);
  });
});
