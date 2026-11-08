/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- each tool call is one prompt, in order */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { PATH_REFUSED_MESSAGE } from "../src/core/paths.ts";
import { createDeepSeekAdapter, finishToStopReason } from "../src/deepseek/index.ts";
import { inProcessClient, tempDir, textOf, updatesOfKind, type InProcessClient } from "./helpers/client.ts";
import { deepSeekFetch } from "./helpers/deepseek.ts";

const env = { DEEPSEEK_API_KEY: "sk-deepseek" };

describe("DeepSeek tool loop (fetch-stubbed SSE)", () => {
  let client: InProcessClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function open(extraEnv: Record<string, string> = {}, mcpServers: McpServer[] = []) {
    const api = deepSeekFetch();
    client = inProcessClient(createDeepSeekAdapter({ fetch: api.fetch }), { ...env, ...extraEnv });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers,
      _meta: { "plane/initialModeId": "yolo" },
    });
    const prompt = (text: string) =>
      client!.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return { api, sessionId, prompt };
  }

  it("streams reasoning as thoughts and sends every reasoning_content back once tools are in play", async () => {
    const { api, prompt } = await open();
    expect((await prompt("hello")).stopReason).toBe("end_turn");
    expect(textOf(client!.updates, "agent_thought_chunk")).toBe("The user greets me.");
    expect(textOf(client!.updates, "agent_message_chunk")).toBe("Hi there");

    expect((await prompt("write")).stopReason).toBe("end_turn");
    // Request 2 is the tool-calling turn, request 3 follows the tool result.
    const followUp = api.requests[2]!.body.messages;
    const assistants = followUp.filter((message: any) => message.role === "assistant");
    expect(assistants.map((message: any) => message.reasoning_content)).toEqual([
      "The user greets me.",
      "I will call write.",
    ]);
    expect(assistants[1].tool_calls[0]).toMatchObject({ id: "call_w", type: "function", function: { name: "write" } });
    expect(followUp.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_w" });
    expect(api.requests[0]!.body).toMatchObject({
      stream: true,
      thinking: { type: "enabled" },
      model: "deepseek-v4-pro",
    });
    expect(api.requests[0]!.headers.get("authorization")).toBe("Bearer sk-deepseek");
  });

  it("sends the session's reasoning effort, starting on DEEPSEEK_REASONING_EFFORT", async () => {
    const { api, sessionId, prompt } = await open({ DEEPSEEK_REASONING_EFFORT: "max" });
    await prompt("hello");
    expect(api.requests[0]!.body.reasoning_effort).toBe("max");
    const result = await client!.agent.request("session/set_config_option", {
      sessionId,
      configId: "effort",
      value: "low",
    });
    expect(result.configOptions.find((option) => option.id === "effort")).toMatchObject({
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    });
    await prompt("hello");
    expect(api.requests[1]!.body.reasoning_effort).toBe("low");
  });

  it("offers efforts on an unlisted model and falls back to high for an unknown level", async () => {
    const unlisted = await open({ PLANE_AGENT_MODEL: "deepseek-v5-preview", DEEPSEEK_REASONING_EFFORT: "max" });
    await unlisted.prompt("hello");
    expect(unlisted.api.requests[0]!.body).toMatchObject({ model: "deepseek-v5-preview", reasoning_effort: "max" });
    await client!.close();

    const invalid = await open({ DEEPSEEK_REASONING_EFFORT: "MAX" });
    await invalid.prompt("hello");
    expect(invalid.api.requests[0]!.body.reasoning_effort).toBe("high");
  });

  it("maps finish reasons and stops at the iteration limit", async () => {
    expect(finishToStopReason("stop")).toBe("end_turn");
    expect(finishToStopReason("length")).toBe("max_tokens");
    expect(finishToStopReason("content_filter")).toBe("refusal");
    const { api, prompt } = await open({ PLANE_AGENT_MAX_ITERATIONS: "3" });
    expect((await prompt("long")).stopReason).toBe("max_tokens");
    expect((await prompt("filter")).stopReason).toBe("refusal");
    const before = api.requests.length;
    expect((await prompt("loop")).stopReason).toBe("max_turn_requests");
    expect(api.requests.length - before).toBe(3);
    expect(updatesOfKind(client!.updates, "usage_update").at(-1)).toMatchObject({ used: 120, size: 1_000_000 });
  });

  it("keeps history valid after a cancel and reports unreachable MCP servers once", async () => {
    const { api, prompt } = await open({}, [
      { type: "http", name: "plane", url: "http://127.0.0.1:9/mcp", headers: [] },
    ]);
    const waiting = prompt("wait");
    await client!.waitFor(() => textOf(client!.updates, "agent_message_chunk").includes("working"));
    await client!.agent.notify("session/cancel", { sessionId: client!.updates[0]!.sessionId });
    expect((await waiting).stopReason).toBe("cancelled");
    expect(updatesOfKind(client!.updates, "notice")).toEqual([
      expect.objectContaining({ severity: "warning", title: expect.stringContaining("MCP server unavailable: plane") }),
    ]);
    expect((await prompt("hello")).stopReason).toBe("end_turn");
    const roles = api.requests.at(-1)!.body.messages.map((message: any) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(updatesOfKind(client!.updates, "notice")).toHaveLength(1);
  });

  it("runs shell commands without the agent's credentials", async () => {
    const { prompt } = await open({ PLANE_TOKEN: "plane_secret" });
    expect((await prompt("env")).stopReason).toBe("end_turn");
    const output = updatesOfKind(client!.updates, "tool_call_update").find(
      (update) => update.toolCallId === "call_env" && update.status === "completed"
    );
    expect(JSON.stringify(output?.content)).toContain("key=unset token=unset home=set");
  });

  it("requires an API key", async () => {
    client = inProcessClient(createDeepSeekAdapter({ fetch: deepSeekFetch().fetch }), {});
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining("DEEPSEEK_API_KEY"),
    });
  });
});

describe("DeepSeek file tools and web fetch", () => {
  let client: InProcessClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function open(mode: "ask_all" | "ask_writes" | "yolo") {
    const cwd = realpathSync(tempDir());
    const home = realpathSync(tempDir("deepseek-home-"));
    const elsewhere = realpathSync(tempDir("deepseek-elsewhere-"));
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "auth.json"), "needle-in-credentials");
    writeFileSync(path.join(cwd, "inside.txt"), "needle-inside");
    writeFileSync(path.join(elsewhere, "outside.txt"), "needle-outside");
    const api = deepSeekFetch();
    client = inProcessClient(createDeepSeekAdapter({ fetch: api.fetch }), { ...env, HOME: home });
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: { "plane/initialModeId": mode },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const mark = client!.updates.length;
      await client!.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: `tool:${name}:${JSON.stringify(args)}` }],
      });
      const finished = updatesOfKind(client!.updates.slice(mark), "tool_call_update").findLast(
        (update) => update.status === "completed" || update.status === "failed"
      );
      return { status: finished?.status, output: JSON.stringify(finished?.content) };
    };
    return { cwd, home, elsewhere, api, call };
  }

  it("reads and searches inside the working directory without asking, in ask_writes", async () => {
    const { call } = await open("ask_writes");
    expect(await call("read", { path: "inside.txt" })).toMatchObject({ status: "completed" });
    expect((await call("grep", { pattern: "needle" })).output).toContain("needle-inside");
    expect((await call("glob", { pattern: "*.txt" })).output).toContain("inside.txt");
    expect(client!.permissionRequests).toHaveLength(0);
  });

  it("asks before a read or search outside the working directory, in ask_writes", async () => {
    const { elsewhere, call } = await open("ask_writes");
    client!.answers.push("reject_once");
    const denied = await call("read", { path: path.join(elsewhere, "outside.txt") });
    expect(denied.status).toBe("failed");
    expect(denied.output).not.toContain("needle-outside");
    expect(client!.permissionRequests).toHaveLength(1);

    client!.answers.push("allow_once");
    const allowed = await call("grep", { pattern: "needle", path: elsewhere });
    expect(allowed.output).toContain("needle-outside");
    expect(client!.permissionRequests).toHaveLength(2);
  });

  it("does not follow a symlink out of the working directory without asking", async () => {
    const { cwd, elsewhere, call } = await open("ask_writes");
    symlinkSync(path.join(elsewhere, "outside.txt"), path.join(cwd, "link.txt"));
    client!.answers.push("reject_once");
    expect((await call("read", { path: "link.txt" })).output).not.toContain("needle-outside");
    expect(client!.permissionRequests).toHaveLength(1);

    const searched = await call("grep", { pattern: "needle" });
    expect(searched.output).toContain("needle-inside");
    expect(searched.output).not.toContain("needle-outside");
    expect(client!.permissionRequests).toHaveLength(1);
  });

  it("asks for a glob that climbs out of the working directory", async () => {
    const { elsewhere, call } = await open("ask_writes");
    client!.answers.push("reject_once");
    await call("glob", { pattern: `${elsewhere}/*` });
    expect(client!.permissionRequests).toHaveLength(1);
    client!.answers.push("reject_once");
    await call("grep", { pattern: "needle", glob: "../**" });
    expect(client!.permissionRequests).toHaveLength(2);
  });

  it("remembers 'always' for one outside path, not for every outside read", async () => {
    const { elsewhere, call } = await open("ask_writes");
    writeFileSync(path.join(elsewhere, "other.txt"), "other");
    client!.answers.push("allow_always");
    await call("read", { path: path.join(elsewhere, "outside.txt") });
    await call("read", { path: path.join(elsewhere, "outside.txt") });
    expect(client!.permissionRequests).toHaveLength(1);
    client!.answers.push("reject_once");
    await call("read", { path: path.join(elsewhere, "other.txt") });
    expect(client!.permissionRequests).toHaveLength(2);
  });

  it.each(["ask_all", "ask_writes", "yolo"] as const)("refuses /proc and credential stores in %s", async (mode) => {
    const { home, cwd, call } = await open(mode);
    symlinkSync(path.join(home, ".codex", "auth.json"), path.join(cwd, "creds"));
    for (const [tool, args] of [
      ["read", { path: "/proc/self/environ" }],
      ["read", { path: path.join(home, ".codex", "auth.json") }],
      ["read", { path: "creds" }],
      ["write", { path: path.join(home, ".codex", "auth.json"), content: "x" }],
      ["edit", { path: "creds", old_string: "needle", new_string: "x" }],
      ["glob", { pattern: "/proc/*/environ" }],
      ["grep", { pattern: "needle", path: path.join(home, ".codex") }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.status, `${tool} ${JSON.stringify(args)}`).toBe("failed");
      expect(result.output).toContain(PATH_REFUSED_MESSAGE);
      expect(result.output).not.toContain("needle-in-credentials");
    }
    expect(client!.permissionRequests).toHaveLength(0);
  });

  it("leaves a symlinked credential file out of a search of the working directory, even in yolo", async () => {
    const { home, cwd, call } = await open("yolo");
    symlinkSync(path.join(home, ".codex", "auth.json"), path.join(cwd, "creds.txt"));
    const searched = await call("grep", { pattern: "needle" });
    expect(searched.output).toContain("needle-inside");
    expect(searched.output).not.toContain("needle-in-credentials");
    expect((await call("glob", { pattern: "*" })).output).not.toContain("creds.txt");
  });

  it("asks before a web fetch in ask_writes and remembers 'always' per host", async () => {
    const { api, call } = await open("ask_writes");
    const fetched = () => api.requests.filter((request) => request.url.includes("example.com"));
    client!.answers.push("reject_once");
    expect((await call("web_fetch", { url: "https://example.com/page" })).status).toBe("failed");
    expect(client!.permissionRequests).toHaveLength(1);
    expect(client!.permissionRequests[0]?.toolCall.kind).toBe("fetch");
    expect(fetched()).toHaveLength(0);

    client!.answers.push("allow_always");
    await call("web_fetch", { url: "https://example.com/page" });
    await call("web_fetch", { url: "https://example.com/other" });
    expect(client!.permissionRequests).toHaveLength(2);
    expect(fetched()).toHaveLength(2);

    client!.answers.push("reject_once");
    await call("web_fetch", { url: "https://other.example/page" });
    expect(client!.permissionRequests).toHaveLength(3);
  });

  it("fetches without asking in yolo", async () => {
    const { api, call } = await open("yolo");
    await call("web_fetch", { url: "https://example.com/page" });
    expect(client!.permissionRequests).toHaveLength(0);
    expect(api.requests.some((request) => request.url.includes("example.com"))).toBe(true);
  });
});
