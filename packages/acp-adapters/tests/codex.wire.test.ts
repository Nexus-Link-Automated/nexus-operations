/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { statSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { codexEfforts, commandTargets } from "../src/codex/index.ts";
import { spawnClient, tempDir, textOf, updatesOfKind, type SpawnedClient } from "./helpers/client.ts";
import { fakeCodexEnv } from "./helpers/codex.ts";
import { runWireScenario } from "./helpers/scenario.ts";

const planeMcp: McpServer = {
  type: "http",
  name: "plane",
  url: "http://mcp.internal/mcp",
  headers: [
    { name: "Authorization", value: "Bearer plane_api_token" },
    { name: "X-Workspace-slug", value: "acme" },
  ],
};

describe("plane-acp-codex over stdio (fake app-server)", () => {
  let client: SpawnedClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("meets the wire contract", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await runWireScenario(client, {
      agentName: "plane-acp-codex",
      cwd: tempDir(),
      mcpServers: [planeMcp],
      prompts: { plain: { text: "hello", reply: "Hi there" }, gated: "run", read: "plane list", wait: "wait" },
      otherModel: "gpt-mini",
    });

    const log = fake.log();
    expect(log[0]?.argv).toEqual(["app-server"]);
    const threadStart = log.find((message) => message.method === "thread/start")?.params as Record<string, unknown>;
    expect(threadStart).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "danger-full-access",
      config: {
        mcp_servers: {
          plane: {
            url: "http://mcp.internal/mcp",
            http_headers: { Authorization: "Bearer plane_api_token", "X-Workspace-slug": "acme" },
            default_tools_approval_mode: "prompt",
          },
        },
        shell_environment_policy: {
          ignore_default_excludes: false,
          exclude: expect.arrayContaining(["*KEY*", "*TOKEN*"]),
        },
        web_search: "disabled",
      },
    });
    const policies = log
      .filter((message) => message.method === "turn/start")
      .map((message) => (message.params as any).approvalPolicy);
    expect(policies).toContain("untrusted");
    expect(policies).toContain("on-request");
    expect(log.some((message) => message.method === "turn/interrupt")).toBe(true);
    const replies = log
      .filter((message) => typeof message.id === "string" && "result" in message)
      .map((message) => (message.result as any).decision);
    expect(replies).toEqual(expect.arrayContaining(["accept", "decline"]));
  });

  it("leaves Codex's web search on only for a session that starts in yolo", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [],
      _meta: { "plane/initialModeId": "yolo" },
    });
    const start = fake.log().find((message) => message.method === "thread/start")?.params as any;
    expect(start.config).not.toHaveProperty("web_search");
  });

  it("asks before reads outside the working directory and refuses sign-in files", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    const prompt = (text: string) =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const decisions = () =>
      fake
        .log()
        .filter((message) => typeof message.id === "string" && "result" in message)
        .map((message) => (message.result as any).decision);

    // Codex escalated it, so it asks even though Codex parsed it as a plain listing.
    await prompt("ls");
    expect(client.permissionRequests).toHaveLength(1);

    client.answers.push("reject_once");
    await prompt("cat etc");
    expect(client.permissionRequests).toHaveLength(2);
    expect(client.permissionRequests[1]?.toolCall.kind).toBe("execute");

    // Refused without asking, even in yolo.
    await client.agent.request("session/set_mode", { sessionId, modeId: "yolo" });
    await prompt("cat creds");
    expect(client.permissionRequests).toHaveLength(2);
    expect(decisions()).toEqual(["accept", "decline", "decline"]);
    expect(textOf(client.updates, "agent_message_chunk")).toContain("skipped");
  });

  it("takes targets only from the commands Codex parsed as reads", () => {
    expect(
      commandTargets([
        { type: "read", command: "cat a", name: "a", path: "/w/a" },
        { type: "listFiles", command: "ls", path: null },
        { type: "search", command: "rg x", query: "x", path: "src" },
        { type: "unknown", command: "curl x" },
      ])
    ).toEqual([{ path: "/w/a" }, { path: "" }, { path: "src" }]);
  });

  async function startSession() {
    client = spawnClient("codex", fakeCodexEnv().env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    return (text: string) => client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  it("asks about a command Codex escalated even if its parser labels it a search", async () => {
    const prompt = await startSession();
    await prompt("search");
    expect(client!.permissionRequests).toHaveLength(1);
    expect(client!.permissionRequests[0]?.toolCall).toMatchObject({
      title: "Run: find . -name x -delete",
      kind: "execute",
    });
  });

  it("remembers an 'always' for the exact command Codex reports, including its shell wrapper", async () => {
    const prompt = await startSession();
    client!.answers.push("allow_always");
    await prompt("cmd /bin/bash -lc 'git status'");
    expect(client!.permissionRequests).toHaveLength(1);
    await prompt("cmd /bin/bash -lc 'git status'");
    expect(client!.permissionRequests).toHaveLength(1);
    // Another command through the same shell wrapper is a new question.
    await prompt("cmd /bin/bash -lc 'git log'");
    expect(client!.permissionRequests).toHaveLength(2);
    // A compound script is never offered "always", and answering it anyway remembers nothing.
    client!.answers.push("allow_always");
    await prompt("cmd /bin/bash -lc 'git status; id'");
    const compound = client!.permissionRequests.at(-1)!;
    expect(compound.options.map((option) => option.optionId)).toEqual(["allow_once", "reject_once"]);
    await prompt("cmd /bin/bash -lc 'git status; id'");
    expect(client!.permissionRequests).toHaveLength(4);
  });

  it("remembers file changes per file, from the paths on the started item", async () => {
    const prompt = await startSession();
    client!.answers.push("allow_always");
    await prompt("patch a.txt");
    expect(client!.permissionRequests.at(-1)!.options[1]).toMatchObject({
      optionId: "allow_always",
      _meta: { "plane/memoryScope": "file" },
    });
    await prompt("patch a.txt");
    expect(client!.permissionRequests).toHaveLength(1);
    await prompt("patch b.txt");
    expect(client!.permissionRequests).toHaveLength(2);
    // Several files in one change: one exact approval at most.
    await prompt("patch a.txt c.txt");
    expect(client!.permissionRequests.at(-1)!.options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);
  });

  it("offers the reasoning efforts model/list reports and sends the chosen one with each turn", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId, configOptions } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    const effort = configOptions?.find((option) => option.id === "effort");
    expect(effort).toMatchObject({ category: "thought_level", currentValue: "medium" });
    expect(effort?.type === "select" && effort.options).toEqual([
      { value: "low", name: "Low", description: "Fast" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High", description: "Thorough" },
    ]);
    const prompt = () =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });

    await client.agent.request("session/set_config_option", { sessionId, configId: "effort", value: "high" });
    await prompt();
    // gpt-mini reports no efforts: the select goes away and turns stop sending one (Codex keeps
    // the thread's last effort, which a model without reasoning ignores).
    const switched = await client.agent.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: "gpt-mini",
    });
    expect(switched.configOptions.map((option) => option.id)).toEqual(["model"]);
    await prompt();

    const turns = fake
      .log()
      .filter((message) => message.method === "turn/start")
      .map((message) => message.params as Record<string, unknown>);
    expect(turns[0]).toMatchObject({ model: "gpt-test", effort: "high" });
    expect(turns[1]).toMatchObject({ model: "gpt-mini" });
    expect(turns[1]).not.toHaveProperty("effort");
  });

  it("starts on the thread's own effort, unless a remembered one is asked for", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", { ...fake.env, FAKE_CODEX_REASONING_EFFORT: "high" });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const plain = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    expect(plain.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("high");
    const remembered = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [],
      _meta: { "plane/initialEffort": "low" },
    });
    expect(remembered.configOptions?.find((option) => option.id === "effort")?.currentValue).toBe("low");
  });

  it("starts on the remembered model the app-server lists", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId, configOptions } = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [],
      _meta: { "plane/initialModel": "gpt-mini", "plane/initialEffort": "high" },
    });
    // gpt-mini takes no effort, so the remembered one is dropped.
    expect(configOptions?.map((option) => [option.id, option.currentValue])).toEqual([["model", "gpt-mini"]]);
    await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    const turn = fake.log().find((message) => message.method === "turn/start")?.params as Record<string, unknown>;
    expect(turn).toMatchObject({ model: "gpt-mini" });
    expect(turn).not.toHaveProperty("effort");
  });

  it("maps model/list efforts, falling back to the lowest level without a usable default", () => {
    expect(
      codexEfforts({
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high", description: "Deep" }],
        defaultReasoningEffort: "medium",
      })
    ).toEqual({
      efforts: [
        { value: "low", name: "Low" },
        { value: "high", name: "High", description: "Deep" },
      ],
    });
    expect(codexEfforts({ supportedReasoningEfforts: [] })).toEqual({});
  });

  it("gates Plane MCP calls through elicitation and streams thoughts, plans and usage", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId, configOptions } = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [planeMcp],
    });
    expect(configOptions?.[0]).toMatchObject({ currentValue: "gpt-test" });
    expect((configOptions?.[0] as any)?.options.map((option: any) => option.value)).toEqual(["gpt-test", "gpt-mini"]);

    await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    expect(textOf(client.updates, "agent_thought_chunk")).toBe("Thinking.");
    expect(updatesOfKind(client.updates, "usage_update")[0]).toMatchObject({ used: 120, size: 400000 });

    client.answers.push("reject_once");
    await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plane" }] });
    expect(client.permissionRequests.at(-1)?.toolCall).toMatchObject({ title: "plane: workitem create", kind: "edit" });
    expect(textOf(client.updates, "agent_message_chunk")).toContain("not created");
    const elicitationReply = fake.log().find((message) => message.id === "srv-1");
    expect(elicitationReply?.result).toMatchObject({ action: "decline" });

    // An approved MCP call is reported on the card its approval opened: one card, completed.
    client.answers.push("allow_once");
    const before = client.updates.length;
    await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "plane" }] });
    const approvalCard = client.permissionRequests.at(-1)!.toolCall.toolCallId;
    const turnUpdates = client.updates.slice(before);
    expect(updatesOfKind(turnUpdates, "tool_call").map((call) => call.toolCallId)).toEqual([approvalCard]);
    expect(
      updatesOfKind(turnUpdates, "tool_call_update").findLast((update) => update.toolCallId === approvalCard)
    ).toMatchObject({
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "created T" } }],
    });
  });

  it("signs in with OPENAI_API_KEY and fails clearly without credentials", async () => {
    const signedOut = fakeCodexEnv({ FAKE_CODEX_SIGNED_IN: "0", OPENAI_API_KEY: "" });
    client = spawnClient("codex", signedOut.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringMatching(/Workspace settings → AI providers.*OPENAI_API_KEY/),
    });
    await client.close();

    const withKey = fakeCodexEnv({ FAKE_CODEX_SIGNED_IN: "0", OPENAI_API_KEY: "sk-test" });
    client = spawnClient("codex", withKey.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    expect(withKey.log().find((message) => message.method === "account/login/start")?.params).toEqual({
      type: "apiKey",
      apiKey: "sk-test",
    });
  });

  it("reports a key the API rejects mid-chat as auth required, and other failed turns as before", async () => {
    const fake = fakeCodexEnv();
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    const prompt = (text: string) =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

    await expect(prompt("badkey")).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining("Codex is not signed in"),
    });
    await expect(prompt("apierror")).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("500 Internal Server Error"),
    });
  });

  it("points the app-server at the broker when the runner sets a base URL", async () => {
    const fake = fakeCodexEnv({ OPENAI_API_KEY: "opaque-token", PLANE_CODEX_BASE_URL: "http://127.0.0.1:9/v1" });
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    const log = fake.log();
    expect(log.find((message) => message.argv)?.argv).toEqual([
      "-c",
      'openai_base_url="http://127.0.0.1:9/v1"',
      "app-server",
    ]);
    expect(log.find((message) => message.method === "account/login/start")?.params).toEqual({
      type: "apiKey",
      apiKey: "opaque-token",
    });
    await client.close();

    const direct = fakeCodexEnv({ OPENAI_API_KEY: "sk-test" });
    client = spawnClient("codex", direct.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    expect(direct.log().find((message) => message.argv)?.argv).toEqual(["app-server"]);
  });

  it("uses the ChatGPT sign-in in ~/.codex with PLANE_AGENT_AUTH=chatgpt and never logs in with a key", async () => {
    const fake = fakeCodexEnv({ PLANE_AGENT_AUTH: "chatgpt", FAKE_CODEX_ACCOUNT: "chatgpt", OPENAI_API_KEY: "sk-x" });
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    const log = fake.log();
    expect(log[0]?.start).toEqual({ codexHome: path.join(fake.env.HOME!, ".codex"), apiKeyInEnv: false });
    expect(log.some((message) => message.method === "account/login/start")).toBe(false);
    await client.close();

    // Signed in with a key only: ChatGPT is not connected.
    const keyOnly = fakeCodexEnv({ PLANE_AGENT_AUTH: "chatgpt" });
    client = spawnClient("codex", keyOnly.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining(
        "ChatGPT is not connected. Sign in with ChatGPT in Workspace settings → AI providers."
      ),
    });
    expect(keyOnly.log().some((message) => message.method === "account/login/start")).toBe(false);
  });

  it("logs in with the current key in a separate CODEX_HOME, even when already signed in", async () => {
    for (const mode of ["api_key", ""]) {
      /* oxlint-disable no-await-in-loop -- one app-server per mode, in turn */
      const fake = fakeCodexEnv({ PLANE_AGENT_AUTH: mode, FAKE_CODEX_ACCOUNT: "chatgpt", OPENAI_API_KEY: "sk-new" });
      client = spawnClient("codex", fake.env);
      await client.agent.request("initialize", { protocolVersion: 1 });
      await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
      const codexHome = path.join(fake.env.HOME!, ".codex-api-key");
      const log = fake.log();
      expect(log[0]?.start).toEqual({ codexHome, apiKeyInEnv: true });
      expect(statSync(codexHome).mode & 0o777).toBe(0o700);
      expect(log.find((message) => message.method === "account/login/start")?.params).toEqual({
        type: "apiKey",
        apiKey: "sk-new",
      });
      await client.close();
      /* oxlint-enable no-await-in-loop */
    }

    const noKey = fakeCodexEnv({ PLANE_AGENT_AUTH: "api_key" });
    client = spawnClient("codex", noKey.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      message: expect.stringContaining("Workspace settings → AI providers"),
    });
  });

  it("fails a stalled turn with the watchdog and surfaces MCP startup failures", async () => {
    const fake = fakeCodexEnv({ PLANE_CODEX_STALL_TIMEOUT_MS: "300", FAKE_CODEX_BROKEN_MCP: "1" });
    client = spawnClient("codex", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    await expect(
      client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "wait" }] })
    ).rejects.toMatchObject({
      message: expect.stringContaining("stalled"),
    });
    expect(updatesOfKind(client.updates, "notice")[0]).toMatchObject({ title: "MCP server broken failed to start" });
    expect(fake.log().some((message) => message.method === "turn/interrupt")).toBe(true);
  });

  describe("waiting on a person", () => {
    const start = async (env: NodeJS.ProcessEnv) => {
      const fake = fakeCodexEnv(env);
      const spawned = spawnClient("codex", fake.env);
      client = spawned;
      await spawned.agent.request("initialize", { protocolVersion: 1 });
      const { sessionId } = await spawned.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
      const prompt = (text: string) =>
        spawned.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      return { fake, spawned, prompt };
    };

    it("does not count an open approval as a stall, and restarts the clock from the answer", async () => {
      // The answer comes after the stall limit, then Codex is quiet for longer than a watchdog tick.
      const { fake, spawned, prompt } = await start({
        PLANE_CODEX_STALL_TIMEOUT_MS: "2000",
        FAKE_CODEX_APPROVAL_PAUSE_MS: "1200",
      });
      spawned.answers.push({ afterMs: 2300, answer: "allow_once" });
      await expect(prompt("run")).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(textOf(spawned.updates, "agent_message_chunk")).toContain("ran it");
      expect(fake.log().some((message) => message.method === "turn/interrupt")).toBe(false);
    });

    it("still stalls when Codex goes quiet after the approval is answered", async () => {
      const { spawned, prompt } = await start({
        PLANE_CODEX_STALL_TIMEOUT_MS: "300",
        FAKE_CODEX_APPROVAL_PAUSE_MS: "5000",
      });
      spawned.answers.push("allow_once");
      await expect(prompt("run")).rejects.toMatchObject({ message: expect.stringContaining("stalled") });
    });

    it("withdraws an open approval when the turn times out, and the next turn still runs", async () => {
      const { fake, spawned, prompt } = await start({ PLANE_CODEX_TURN_TIMEOUT_MS: "500" });
      spawned.answers.push("hold");
      await expect(prompt("run")).rejects.toMatchObject({ message: expect.stringContaining("timed out") });
      await expect(prompt("hello")).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(textOf(spawned.updates, "agent_message_chunk")).toContain("Hi there");
      const decisions = fake
        .log()
        .filter((message) => typeof message.id === "string" && "result" in message)
        .map((message) => (message.result as any).decision);
      expect(decisions).toEqual(["cancel"]);
    });

    it("ends a failed turn even when the client never answers the withdrawn approval", async () => {
      const { spawned, prompt } = await start({ PLANE_CODEX_TURN_TIMEOUT_MS: "500" });
      spawned.answers.push("ignore");
      await expect(prompt("run")).rejects.toMatchObject({ message: expect.stringContaining("timed out") });
      expect(spawned.permissionRequests).toHaveLength(1);
    });
  });
});
