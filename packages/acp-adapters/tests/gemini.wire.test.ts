/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- polling until the process is gone */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy } from "../src/core/paths.ts";
import { geminiPolicyPath, geminiSystemSettingsPath } from "../src/gemini/files.ts";
import { describeGeminiToolCall, geminiFileVerdict } from "../src/gemini/index.ts";
import { spawnClient, tempDir, textOf, updatesOfKind, type SpawnedClient } from "./helpers/client.ts";
import { fakeGeminiEnv } from "./helpers/gemini.ts";
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

const prompt = (client: SpawnedClient, sessionId: string, text: string) =>
  client.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

/** The permission replies the adapter sent to Gemini, in order. */
function permissionReplies(log: Record<string, any>[]): unknown[] {
  return log
    .filter((entry) => typeof entry.id === "number" && "result" in entry && entry.result.outcome)
    .map((entry) => entry.result.outcome);
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("plane-acp-gemini over stdio (fake gemini --acp)", () => {
  let client: SpawnedClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("meets the wire contract with an API key", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key", KEEP_ME: "1", OTHER_SECRET: "s3cret" });
    client = spawnClient("gemini", fake.env);
    await runWireScenario(client, {
      agentName: "plane-acp-gemini",
      cwd: tempDir(),
      mcpServers: [planeMcp],
      prompts: { plain: { text: "hello", reply: "Hi there" }, gated: "run", read: "read", wait: "wait" },
      otherModel: "gemini-2.5-pro",
    });
    expect(client.stderr()).toBe("");

    const [start] = fake.starts();
    expect(start?.argv).toEqual([
      "--acp",
      "--approval-mode",
      "default",
      "--extensions",
      "none",
      "--admin-policy",
      geminiPolicyPath(),
      "--allowed-mcp-server-names",
      "plane",
    ]);
    const cliHome = path.join(fake.home, ".gemini-api-key");
    expect(start?.env).toEqual({
      HOME: fake.home,
      GEMINI_CLI_HOME: cliHome,
      GEMINI_CLI_NO_RELAUNCH: "true",
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: geminiSystemSettingsPath("api_key"),
      GEMINI_TELEMETRY_ENABLED: "false",
      KEEP_ME: "1",
    });
    // The key only travels in `authenticate`.
    expect(start?.secretNames).toEqual([]);
    expect(statSync(cliHome).mode & 0o777).toBe(0o700);

    const log = fake.log();
    expect(log.find((entry) => entry.method === "authenticate")?.params).toEqual({
      methodId: "gemini-api-key",
      _meta: { "api-key": "AIza-test-key" },
    });
    expect(log.find((entry) => entry.method === "session/new")?.params.mcpServers).toEqual([planeMcp]);
    expect(log.find((entry) => entry.method === "session/set_model")?.params).toMatchObject({
      modelId: "gemini-2.5-pro",
    });
    // Gemini stays in its own default mode; the gate answers its permission requests.
    expect(log.some((entry) => entry.method === "session/set_mode")).toBe(false);
    expect(log.some((entry) => entry.method === "session/cancel")).toBe(true);
    const replies = permissionReplies(log);
    expect(replies).toContainEqual({ outcome: "selected", optionId: "proceed_once" });
    expect(replies).toContainEqual({ outcome: "selected", optionId: "cancel" });
    expect(replies).not.toContainEqual(expect.objectContaining({ optionId: expect.stringMatching(/always/) }));
  });

  it("gates Plane MCP calls by action and remembers 'always' in the adapter", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId, configOptions } = await client.agent.request("session/new", {
      cwd: tempDir(),
      mcpServers: [planeMcp],
    });
    expect(configOptions?.[0]).toMatchObject({ id: "model", category: "model", currentValue: "auto" });
    expect((configOptions![0] as any).options.map((option: any) => option.value)).toEqual([
      "auto",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);

    // ask_writes: a Plane read runs without asking, a mutation asks.
    await prompt(client, sessionId, "plane list");
    expect(client.permissionRequests).toHaveLength(0);
    expect(textOf(client.updates, "agent_message_chunk")).toContain("listed");

    client.answers.push("allow_always");
    await prompt(client, sessionId, "plane");
    expect(client.permissionRequests).toHaveLength(1);
    expect(client.permissionRequests[0]?.toolCall).toMatchObject({
      title: "workitem(action: create, name: T)",
      kind: "other",
    });
    // Remembered by the adapter: the second create does not ask, and Gemini only ever got "once".
    await prompt(client, sessionId, "plane");
    expect(client.permissionRequests).toHaveLength(1);
    expect(permissionReplies(fake.log())).toEqual([
      { outcome: "selected", optionId: "proceed_once" },
      { outcome: "selected", optionId: "proceed_once" },
      { outcome: "selected", optionId: "proceed_once" },
    ]);

    // The approved call is reported on the card Gemini opened: one card, completed.
    const calls = updatesOfKind(client.updates, "tool_call");
    expect(calls.every((call) => call.toolCallId.startsWith("mcp_plane_workitem__"))).toBe(true);
    expect(updatesOfKind(client.updates, "tool_call_update").at(-1)).toMatchObject({ status: "completed" });
    // Gemini's slash-command list is not part of the contract.
    expect(updatesOfKind(client.updates, "available_commands_update")).toEqual([]);
  });

  it("asks before web fetches, web searches and reads outside the cwd in ask_writes", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });

    await prompt(client, sessionId, "read");
    expect(client.permissionRequests).toHaveLength(0);
    for (const [index, text] of ["read etc", "fetch", "web search"].entries()) {
      client.answers.push("reject_once");
      await prompt(client, sessionId, text);
      expect(client.permissionRequests, text).toHaveLength(index + 1);
    }
    expect(permissionReplies(fake.log())).toEqual([
      { outcome: "selected", optionId: "proceed_once" },
      { outcome: "selected", optionId: "cancel" },
      { outcome: "selected", optionId: "cancel" },
      { outcome: "selected", optionId: "cancel" },
    ]);
  });

  it("refuses credential files in every mode without asking", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    for (const modeId of ["ask_all", "ask_writes", "yolo"]) {
      await client.agent.request("session/set_mode", { sessionId, modeId });
      await prompt(client, sessionId, "read creds");
    }
    expect(client.permissionRequests).toHaveLength(0);
    expect(permissionReplies(fake.log())).toEqual([
      { outcome: "selected", optionId: "cancel" },
      { outcome: "selected", optionId: "cancel" },
      { outcome: "selected", optionId: "cancel" },
    ]);
    expect(textOf(client.updates, "agent_message_chunk")).toBe("skippedskippedskipped");
  });

  it("sends a prompt that starts with / to the model, not to Gemini's own commands", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    await prompt(client, sessionId, "/extensions install https://example.com/x");
    expect(textOf(client.updates, "agent_message_chunk")).toBe("ok");
    const sent = fake.log().find((entry) => entry.method === "session/prompt")?.params.prompt;
    expect(sent[0]).toEqual({ type: "text", text: "\u200B" });
    expect(fake.starts()[0]?.argv.at(-1)).toBe("plane-acp-none");
  });

  it("signs in with the Google account the login helper cached", async () => {
    const fake = fakeGeminiEnv({ PLANE_AGENT_AUTH: "google_account", GEMINI_API_KEY: "AIza-ignored" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining(
        "Google account is not connected. Sign in with Google in Workspace settings → AI providers."
      ),
    });
    // Nothing was started: no browser or stdin sign-in flow can run.
    expect(fake.starts()).toEqual([]);

    const geminiDir = path.join(fake.home, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(
      path.join(geminiDir, "oauth_creds.json"),
      JSON.stringify({ access_token: "ya29", refresh_token: "1//r" })
    );
    writeFileSync(
      path.join(geminiDir, "settings.json"),
      JSON.stringify({ ui: { theme: "x" }, security: { auth: { selectedType: "gemini-api-key" } } })
    );
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    expect(sessionId).toBeTruthy();
    const [start] = fake.starts();
    expect(start?.env.GEMINI_CLI_HOME).toBeUndefined();
    expect(start?.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(geminiSystemSettingsPath("google_account"));
    expect(start?.secretNames).toEqual([]);
    expect(fake.log().find((entry) => entry.method === "authenticate")?.params).toEqual({ methodId: "oauth-personal" });
    // selectedType matches before authenticating, so Gemini does not clear the cached sign-in.
    expect(JSON.parse(readFileSync(path.join(geminiDir, "settings.json"), "utf8"))).toEqual({
      ui: { theme: "x" },
      security: { auth: { selectedType: "oauth-personal" } },
    });
  });

  it("fails clearly without credentials and on a rejected key", async () => {
    const fake = fakeGeminiEnv();
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringContaining("Workspace settings → AI providers"),
    });
    await client.close();

    const rejected = fakeGeminiEnv({ GEMINI_API_KEY: "bad", FAKE_GEMINI_REJECT: "bad" });
    client = spawnClient("gemini", rejected.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
      message: expect.stringMatching(/Gemini rejected the API key.*Workspace settings → AI providers/),
    });
    await client.close();

    const unsupported = fakeGeminiEnv({ PLANE_AGENT_AUTH: "chatgpt", GEMINI_API_KEY: "k" });
    client = spawnClient("gemini", unsupported.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await expect(client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] })).rejects.toMatchObject({
      message: expect.stringContaining("PLANE_AGENT_AUTH=chatgpt is not supported"),
    });
  });

  it("cancels a turn while a permission prompt is open", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    client.answers.push("hold");
    const running = prompt(client, sessionId, "run");
    await client.waitFor(() => client!.permissionRequests.length > 0);
    await client.agent.notify("session/cancel", { sessionId });
    expect((await running).stopReason).toBe("cancelled");
    expect(permissionReplies(fake.log())).toEqual([{ outcome: "cancelled" }]);
    // The session is still usable.
    expect((await prompt(client, sessionId, "hello")).stopReason).toBe("end_turn");
  });

  it("reports a model error with the settings hint", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    await expect(prompt(client, sessionId, "fail")).rejects.toMatchObject({
      message: expect.stringContaining("Gemini rejected the credentials"),
    });
  });

  it("starts on PLANE_AGENT_MODEL and resumes a session with session/load", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key", PLANE_AGENT_MODEL: "gemini-3-preview" });
    const cwd = tempDir();
    client = spawnClient("gemini", fake.env);
    const init = await client.agent.request("initialize", { protocolVersion: 1 });
    expect(init.agentCapabilities?.loadSession).toBe(true);
    const { sessionId, configOptions } = await client.agent.request("session/new", { cwd, mcpServers: [] });
    expect(configOptions?.[0]).toMatchObject({ currentValue: "gemini-3-preview" });
    expect((configOptions![0] as any).options[0]).toMatchObject({ value: "gemini-3-preview" });
    await prompt(client, sessionId, "hello");
    await client.close();

    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    const loaded = await client.agent.request("session/load", { sessionId, cwd, mcpServers: [] });
    expect(loaded.modes?.currentModeId).toBe("ask_writes");
    const replay = client.updates.filter((notification) => notification.sessionId === sessionId);
    expect(replay.map((notification) => notification.update)).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" }, messageId: "h-1" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi there" }, messageId: "h-2" },
      expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "read_file__old_1", status: "completed" }),
    ]);
    const loadedIn = fake.log().find((entry) => entry.method === "session/load")?.params;
    expect(loadedIn).toMatchObject({ sessionId: "gem-session-1", cwd });

    await expect(
      client.agent.request("session/load", { sessionId: "00000000-0000-4000-8000-000000000000", cwd, mcpServers: [] })
    ).rejects.toMatchObject({ code: -32002 });
  });

  it("kills Gemini's process group when the connection closes", async () => {
    const fake = fakeGeminiEnv({ GEMINI_API_KEY: "AIza-test-key" });
    client = spawnClient("gemini", fake.env);
    await client.agent.request("initialize", { protocolVersion: 1 });
    await client.agent.request("session/new", { cwd: tempDir(), mcpServers: [] });
    const pid = fake.starts()[0]!.pid;
    process.kill(pid, 0);
    client.child.kill("SIGTERM");
    expect(await gone(pid)).toBe(true);
  });
});

describe("innermostApiMessage", () => {
  it("unwraps Google's JSON-in-JSON error messages", async () => {
    const { innermostApiMessage } = await import("../src/gemini/index.ts");
    const inner = JSON.stringify(
      { error: { code: 400, message: "API key not valid. Please pass a valid API key." } },
      null,
      2
    );
    const outer = JSON.stringify({ error: { message: inner } });
    expect(innermostApiMessage(outer)).toBe("API key not valid. Please pass a valid API key.");
    expect(innermostApiMessage("plain failure")).toBe("plain failure");
  });
});

describe("Gemini file tools and web tools", () => {
  const cwd = "/work/session";
  const paths = new PathPolicy(cwd, { HOME: "/home/agent" });
  const verdict = (name: string, title: string, kind: string, locations?: unknown) =>
    geminiFileVerdict({ toolCallId: `${name}__1`, title, kind, locations }, paths).access;

  it("checks the absolute locations read_file, write_file and replace report", () => {
    expect(verdict("read_file", "a.txt", "read", [{ path: "/work/session/a.txt" }])).toBe("inside");
    expect(verdict("read_file", "b", "read", [{ path: "/etc/hostname" }])).toBe("outside");
    expect(verdict("read_file", "b", "read", [{ path: "/proc/self/environ" }])).toBe("refused");
    expect(verdict("write_file", "b", "edit", [{ path: "/home/agent/.gemini/oauth_creds.json" }])).toBe("refused");
    expect(verdict("replace", "b", "edit", [{ path: "/home/agent/.gemini-api-key/.gemini/settings.json" }])).toBe(
      "refused"
    );
  });

  it("trusts Gemini's own confinement for the read tools that report no location", () => {
    for (const name of ["list_directory", "grep_search", "read_many_files"]) {
      expect(verdict(name, "src", name === "read_many_files" ? "read" : "search", []), name).toBe("inside");
    }
  });

  it("reads a glob's pattern from its title, because Gemini does not confine it", () => {
    expect(verdict("glob", "'**/*.ts'", "search", [])).toBe("inside");
    expect(verdict("glob", "'*.ts' within src", "search", [])).toBe("inside");
    expect(verdict("glob", "'/etc/*'", "search", [])).toBe("outside");
    expect(verdict("glob", "'../*'", "search", [])).toBe("outside");
    expect(verdict("glob", "'/proc/*/environ'", "search", [])).toBe("refused");
    expect(verdict("glob", "'~/.gemini/*'", "search", [])).toBe("refused");
  });

  it("fails closed for a read or search it cannot place", () => {
    expect(verdict("glob", "no quotes here", "search", [])).toBe("outside");
    expect(verdict("some_new_reader", "x", "read", [])).toBe("outside");
    expect(verdict("read_file", "a.txt", "read", [])).toBe("outside");
  });

  it("does not put a path check on tools that touch no files", () => {
    expect(verdict("run_shell_command", "ls", "execute", [])).toBe("inside");
    expect(verdict("mcp_plane_workitem", "workitem(action: list)", "other", [])).toBe("inside");
    expect(verdict("google_web_search", 'Searching the web for: "x"', "search", [])).toBe("inside");
  });

  it("counts web search as a fetch even though Gemini declares it a search", () => {
    const description = describeGeminiToolCall(
      { toolCallId: "google_web_search__1", title: 'Searching the web for: "x"', kind: "search" },
      []
    );
    expect(description).toEqual({ category: "fetch", memoryKey: "gemini:google_web_search" });
  });

  it("remembers 'always' for one web fetch, not every fetch", () => {
    const description = describeGeminiToolCall({ toolCallId: "web_fetch__1", title: "Fetch one", kind: "fetch" }, []);
    expect(description).toEqual({ category: "fetch", memoryKey: "gemini:web_fetch:Fetch one" });
  });
});
