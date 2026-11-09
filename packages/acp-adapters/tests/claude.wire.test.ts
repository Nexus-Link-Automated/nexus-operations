/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- each tool call is one prompt, in order */
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudeFileTargets, createClaudeAdapter } from "../src/claude/index.ts";
import { PATH_REFUSED_MESSAGE } from "../src/core/paths.ts";
import { inProcessClient, tempDir, textOf, updatesOfKind, type InProcessClient } from "./helpers/client.ts";
import { fakeQuery } from "./helpers/claude.ts";
import { runWireScenario } from "./helpers/scenario.ts";

const env = { ANTHROPIC_API_KEY: "sk-ant-test", HOME: tempDir("claude-home-") };

describe("plane-acp-claude over ndjson (mocked query())", () => {
  let client: InProcessClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("meets the wire contract", async () => {
    const fake = fakeQuery();
    client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), env);
    const sessionId = await runWireScenario(client, {
      agentName: "plane-acp-claude",
      cwd: tempDir(),
      mcpServers: [
        { type: "http", name: "plane", url: "http://mcp/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
      ],
      prompts: { plain: { text: "hello", reply: "Hi there" }, gated: "run", read: "read", wait: "wait" },
      otherModel: "claude-sonnet-5-5",
    });

    const [first, second] = fake.calls;
    expect(first?.options).toMatchObject({
      model: "claude-opus-5-5",
      includePartialMessages: true,
      permissionMode: "default",
      settingSources: [],
      sessionId,
    });
    expect(first?.options.mcpServers).toBeUndefined();
    expect(first?.options.extraArgs?.["mcp-config"]).toMatch(/\/\.plane-acp\/mcp-[^/]+\.json$/);
    expect(first?.options.resume).toBeUndefined();
    expect(first?.options.env).toMatchObject({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(second?.options.resume).toBe("00000000-0000-4000-8000-000000000001");
    expect(fake.calls.some((call) => call.options.permissionMode === "bypassPermissions")).toBe(true);
    expect(textOf(client.updates, "agent_thought_chunk")).toContain("Hmm.");
    expect(updatesOfKind(client.updates, "usage_update")[0]).toMatchObject({
      used: 120,
      size: 1_000_000,
      cost: { amount: 0.0123, currency: "USD" },
    });
  });

  it("offers a reasoning effort per model, starts on the browser's last choice and sends it each turn", async () => {
    const fake = fakeQuery();
    client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const created = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [],
      _meta: { "plane/initialModel": "claude-sonnet-5-5", "plane/initialEffort": "xhigh" },
    });
    const { sessionId } = created;
    expect(created.configOptions?.map((option) => [option.id, option.category, option.currentValue])).toEqual([
      ["model", "model", "claude-sonnet-5-5"],
      ["effort", "thought_level", "xhigh"],
    ]);
    const prompt = () =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    await prompt();
    expect(fake.calls[0]?.options).toMatchObject({ model: "claude-sonnet-5-5", effort: "xhigh" });

    const lowered = await client.agent.request("session/set_config_option", {
      sessionId,
      configId: "effort",
      value: "low",
    });
    expect(lowered.configOptions.find((option) => option.id === "effort")?.currentValue).toBe("low");
    // Every Claude model takes `low`, so switching models keeps it.
    const switched = await client.agent.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: "claude-haiku-5-5",
    });
    expect(switched.configOptions.map((option) => option.currentValue)).toEqual(["claude-haiku-5-5", "low"]);
    await prompt();
    expect(fake.calls[1]?.options).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });

    await expect(
      client.agent.request("session/set_config_option", { sessionId, configId: "effort", value: "ultra" })
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("gives an unlisted PLANE_AGENT_MODEL the usual efforts", async () => {
    const fake = fakeQuery();
    client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), {
      ...env,
      PLANE_AGENT_MODEL: "claude-opus-6",
    });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const created = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    expect(created.configOptions?.map((option) => option.currentValue)).toEqual(["claude-opus-6", "high"]);
    await client.agent.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(fake.calls[0]?.options).toMatchObject({ model: "claude-opus-6", effort: "high" });
  });

  it("ignores a remembered model it does not offer and starts on the configured effort", async () => {
    const fake = fakeQuery();
    client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), {
      ...env,
      PLANE_AGENT_EFFORT: "high",
    });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const created = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [],
      _meta: { "plane/initialModel": "claude-retired-1", "plane/initialEffort": "ultra" },
    });
    expect(created.configOptions?.map((option) => option.currentValue)).toEqual(["claude-opus-5-5", "high"]);
  });

  it("maps TodoWrite to a plan and max_tokens to its stop reason, and requires credentials", async () => {
    const fake = fakeQuery();
    client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "todo" }] });
    expect(updatesOfKind(client.updates, "plan")[0]?.entries).toEqual([
      { content: "Plan it", priority: "medium", status: "in_progress" },
    ]);
    expect(client.permissionRequests).toHaveLength(0);
    expect(
      (await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "long" }] })).stopReason
    ).toBe("max_tokens");
    await client.close();

    client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), {});
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining("add one in Workspace settings → AI providers"),
    });
  });

  it("loads a stored session by replaying its history", async () => {
    const fake = fakeQuery();
    const stored = [
      {
        type: "user",
        uuid: "1",
        session_id: "s",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "user", content: "earlier question" },
      },
      {
        type: "assistant",
        uuid: "2",
        session_id: "s",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      },
    ];
    const adapter = createClaudeAdapter({
      query: fake.query as never,
      getSessionMessages: (async () => stored) as never,
      listSessions: (async () => [
        { sessionId: "11111111-1111-4111-8111-111111111111", summary: "Earlier", lastModified: 0 },
      ]) as never,
    });
    client = inProcessClient(adapter, env);
    const init = await client.agent.request("initialize", { protocolVersion: 1 });
    expect(init.agentCapabilities).toMatchObject({ loadSession: true, sessionCapabilities: { list: {} } });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const loaded = await client.agent.request("session/load", { sessionId, cwd: tempDir(), mcpServers: [] });
    expect(loaded.modes?.currentModeId).toBe("ask_writes");
    expect(textOf(client.updates, "agent_message_chunk")).toBe("earlier answer");
    expect(updatesOfKind(client.updates, "user_message_chunk")[0]?.content).toEqual({
      type: "text",
      text: "earlier question",
    });
    await client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    expect(fake.calls[0]?.options.resume).toBe(sessionId);
    const listed = await client.agent.request("session/list", {});
    expect(listed.sessions[0]).toMatchObject({ sessionId, title: "Earlier" });
  });

  describe("file tools and web fetch", () => {
    async function open(mode: "ask_all" | "ask_writes" | "yolo") {
      const cwd = realpathSync(tempDir());
      const home = realpathSync(tempDir("claude-home-"));
      const fake = fakeQuery();
      client = inProcessClient(createClaudeAdapter({ query: fake.query as never }), { ...env, HOME: home });
      await client.agent.request("initialize", { protocolVersion: 1 });
      const { sessionId } = await client.agent.request("session/new", {
        cwd,
        mcpServers: [],
        _meta: { "plane/initialModeId": mode },
      });
      const call = async (name: string, input: Record<string, unknown>) => {
        await client!.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: `tool:${name}:${JSON.stringify(input)}` }],
        });
        return fake.hookOutputs.at(-1);
      };
      return { cwd, home, call };
    }

    it("runs reads and searches inside the working directory without asking, in ask_writes", async () => {
      const { cwd, call } = await open("ask_writes");
      for (const [name, input] of [
        ["Read", { file_path: path.join(cwd, "a.txt") }],
        ["Read", { file_path: "a.txt" }],
        ["Glob", { pattern: "**/*.ts" }],
        ["Grep", { pattern: "x", path: cwd }],
      ] as const) {
        expect((await call(name, input))?.permissionDecision, name).toBe("allow");
      }
      expect(client!.permissionRequests).toHaveLength(0);
    });

    it("asks before reads and searches outside the working directory, in ask_writes", async () => {
      const { call } = await open("ask_writes");
      const outside = [
        ["Read", { file_path: "/etc/hostname" }],
        ["Read", { file_path: "../sibling/a.txt" }],
        ["Glob", { pattern: "/etc/*" }],
        ["Glob", { pattern: "*", path: "/etc" }],
        ["Grep", { pattern: "x", path: "/etc" }],
      ] as const;
      for (const [index, [name, input]] of outside.entries()) {
        client!.answers.push("reject_once");
        expect((await call(name, input))?.permissionDecision, name).toBe("deny");
        expect(client!.permissionRequests).toHaveLength(index + 1);
      }
      client!.answers.push("allow_once");
      expect((await call("Read", { file_path: "/etc/hostname" }))?.permissionDecision).toBe("allow");
    });

    it("runs outside reads without asking in yolo, and asks for everything in ask_all", async () => {
      const yolo = await open("yolo");
      expect((await yolo.call("Read", { file_path: "/etc/hostname" }))?.permissionDecision).toBe("allow");
      expect(client!.permissionRequests).toHaveLength(0);
      await client!.close();

      const all = await open("ask_all");
      client!.answers.push("allow_once");
      await all.call("Read", { file_path: "a.txt" });
      expect(client!.permissionRequests).toHaveLength(1);
    });

    it.each(["ask_all", "ask_writes", "yolo"] as const)("refuses /proc and credential stores in %s", async (mode) => {
      const { cwd, home, call } = await open(mode);
      mkdirSync(path.join(home, ".codex"));
      symlinkSync(path.join(home, ".claude", ".credentials.json"), path.join(cwd, "creds"));
      for (const [name, input] of [
        ["Read", { file_path: "/proc/self/environ" }],
        ["Read", { file_path: "~/.claude/.credentials.json" }],
        ["Read", { file_path: path.join(home, ".codex", "auth.json") }],
        ["Read", { file_path: "creds" }],
        ["Write", { file_path: path.join(home, ".codex", "config.toml"), content: "x" }],
        ["Edit", { file_path: path.join(home, ".claude.json"), old_string: "a", new_string: "b" }],
        ["NotebookEdit", { notebook_path: path.join(home, ".gemini", "oauth_creds.json"), new_source: "x" }],
        ["Glob", { pattern: "/proc/*/environ" }],
        ["Glob", { pattern: "*", path: path.join(home, ".codex") }],
        ["Grep", { pattern: "token", path: path.join(home, ".gemini") }],
      ] as const) {
        const output = await call(name, input);
        expect(output?.permissionDecision, `${name} ${JSON.stringify(input)}`).toBe("deny");
        expect(output?.permissionDecisionReason).toBe(PATH_REFUSED_MESSAGE);
      }
      expect(client!.permissionRequests).toHaveLength(0);
    });

    it("asks before a web fetch or search in ask_writes, and remembers 'always' per host", async () => {
      const { call } = await open("ask_writes");
      client!.answers.push("reject_once");
      expect((await call("WebFetch", { url: "https://example.com/a", prompt: "p" }))?.permissionDecision).toBe("deny");
      expect(client!.permissionRequests).toHaveLength(1);
      client!.answers.push("reject_once");
      expect((await call("WebSearch", { query: "q" }))?.permissionDecision).toBe("deny");
      expect(client!.permissionRequests).toHaveLength(2);

      client!.answers.push("allow_always");
      await call("WebFetch", { url: "https://example.com/a", prompt: "p" });
      await call("WebFetch", { url: "https://example.com/b", prompt: "p" });
      expect(client!.permissionRequests).toHaveLength(3);
    });

    it("maps each tool's path arguments", () => {
      expect(claudeFileTargets("Bash", { command: "cat /etc/passwd" })).toEqual([]);
      expect(claudeFileTargets("Grep", { pattern: "x", path: "src", glob: "*.ts" })).toEqual([
        { path: "src", glob: "*.ts" },
      ]);
    });
  });
});
