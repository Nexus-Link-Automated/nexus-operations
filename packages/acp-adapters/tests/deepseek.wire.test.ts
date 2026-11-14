/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { spawnClient, tempDir, type SpawnedClient } from "./helpers/client.ts";
import { deepSeekServer } from "./helpers/deepseek.ts";
import { planeMcpServer } from "./helpers/mcp-server.ts";
import { runWireScenario } from "./helpers/scenario.ts";

const env = () => ({ DEEPSEEK_API_KEY: "sk-deepseek", HOME: tempDir("deepseek-home-") });

describe("plane-acp-deepseek over stdio (local SSE + MCP servers)", () => {
  let api: Awaited<ReturnType<typeof deepSeekServer>>;
  let mcp: Awaited<ReturnType<typeof planeMcpServer>>;
  let client: SpawnedClient | undefined;
  beforeAll(async () => {
    api = await deepSeekServer();
    mcp = await planeMcpServer();
  });
  afterAll(async () => {
    await api.close();
    await mcp.close();
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("meets the wire contract with built-in and Plane MCP tools", async () => {
    const cwd = tempDir();
    client = spawnClient("deepseek", { ...env(), DEEPSEEK_BASE_URL: api.url });
    await runWireScenario(client, {
      agentName: "plane-acp-deepseek",
      cwd,
      mcpServers: [
        {
          type: "http",
          name: "plane",
          url: mcp.url,
          headers: [
            { name: "Authorization", value: "Bearer plane_api_token" },
            { name: "X-Workspace-slug", value: "acme" },
          ],
        },
      ],
      prompts: { plain: { text: "hello", reply: "Hi there" }, gated: "write", read: "plane list", wait: "wait" },
      otherModel: "deepseek-flash",
    });

    expect(readFileSync(path.join(cwd, "out.txt"), "utf8")).toBe("hello file");
    expect(mcp.calls.length).toBeGreaterThan(0);
    expect(mcp.calls[0]).toMatchObject({
      tool: "workitem",
      args: { action: "list" },
      authorization: "Bearer plane_api_token",
      workspace: "acme",
    });
    expect(api.requests[0].authorization).toBe("Bearer sk-deepseek");
    expect(api.requests[0].url).toBe("/chat/completions");
    expect(api.requests.at(-1).body.model).toBe("deepseek-v4-pro");
    const tools = api.requests[0].body.tools.map((tool: any) => tool.function.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "bash",
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "web_fetch",
        "todo",
        "mcp__plane__workitem",
      ])
    );
  });

  it("remembers 'always' per exact command and per file", async () => {
    const cwd = tempDir();
    client = spawnClient("deepseek", { ...env(), DEEPSEEK_BASE_URL: api.url });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd, mcpServers: [] });
    const prompt = (text: string) =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const asked = () => client!.permissionRequests.length;

    client.answers.push("allow_always");
    await prompt("bash echo one");
    expect(asked()).toBe(1);
    await prompt("bash echo   one");
    expect(asked()).toBe(1);
    await prompt("bash echo two");
    expect(asked()).toBe(2);
    await prompt("bash echo one; echo two");
    expect(asked()).toBe(3);
    expect(client.permissionRequests.at(-1)!.options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);

    client.answers.push("allow_always");
    await prompt("write a.txt");
    expect(asked()).toBe(4);
    await prompt("write a.txt");
    expect(asked()).toBe(4);
    await prompt("write b.txt");
    expect(asked()).toBe(5);
  });

  it("picks the conversation back up in a new process with session/load", async () => {
    const cwd = tempDir();
    const agentEnv = { ...env(), DEEPSEEK_BASE_URL: api.url };
    client = spawnClient("deepseek", agentEnv);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd, mcpServers: [] });
    const prompt = (text: string) =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    await prompt("hello");
    client.answers.push("reject_once");
    await prompt("write");
    await client.close();

    client = spawnClient("deepseek", agentEnv);
    const init = await client.agent.request("initialize", { protocolVersion: 1 });
    expect(init.agentCapabilities?.loadSession).toBe(true);
    const loaded = await client.agent.request("session/load", { sessionId, cwd, mcpServers: [] });
    expect(loaded.modes?.currentModeId).toBe("ask_writes");
    expect(client.updates.map((notification) => notification.update)).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" }, messageId: "h-1" },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "The user greets me." },
        messageId: "h-2",
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi there" }, messageId: "h-3" },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "write" }, messageId: "h-4" },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I will call write." }, messageId: "h-5" },
      expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "call_w", kind: "edit", status: "failed" }),
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done: The" }, messageId: "h-6" },
    ]);

    const before = api.requests.length;
    expect((await prompt("again")).stopReason).toBe("end_turn");
    const messages = api.requests[before].body.messages;
    expect(messages.map((message: any) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(messages[2]).toEqual({ role: "assistant", content: "Hi there", reasoning_content: "The user greets me." });
    expect(messages[5]).toEqual({ role: "tool", tool_call_id: "call_w", content: "The user denied this tool call." });
    expect(messages.at(-1)).toEqual({ role: "user", content: "again" });

    const load = (id: string) => client!.agent.request("session/load", { sessionId: id, cwd, mcpServers: [] });
    await expect(load("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: -32002 });
    await expect(load("../outside")).rejects.toMatchObject({ code: -32002 });
  });
});
