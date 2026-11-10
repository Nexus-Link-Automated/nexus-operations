/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { FakeAgent, PromptScript } from "./helpers/fake-agent.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";
import { AGENT_ID, BRIDGE_SECRET, MCP_URL, USER_ID, WORKSPACE_ID, WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { waitUntil } from "./helpers/ws-client.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const RUN_ID = "0123456789abcdef0123456789abcdef";

function request(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    user_id: USER_ID,
    workspace_slug: WORKSPACE_SLUG,
    agent_id: AGENT_ID,
    permission_level: "ask_writes",
    prompt: "Ada mentioned you: what's left for the release?",
    timeout_ms: 5_000,
    ...overrides,
  };
}

async function start(
  h: Harness,
  body: Record<string, unknown> = request(),
  headers: Record<string, string> = { "X-Agent-Bridge-Secret": BRIDGE_SECRET }
) {
  return h.http("/internal/channel-sessions", { method: "POST", body, cookie: null, origin: null, headers });
}

async function reply(h: Harness): Promise<Record<string, unknown>> {
  return waitUntil(() => h.api.replies[0]);
}

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

describe("POST /internal/channel-sessions", () => {
  it("runs one turn as the user who asked, and reports the answer", async () => {
    harness = await startHarness();
    harness.transport.script = async (agent) => {
      await agent.update(chunk("Two items "));
      await agent.update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "List work items",
        status: "completed",
      });
      await agent.update(chunk("are left: **WEB-1** and **WEB-2**."));
      return { stopReason: "end_turn" };
    };
    const response = await start(harness);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(await reply(harness)).toEqual({
      run_id: RUN_ID,
      status: "ok",
      text: "Two items \n\nare left: **WEB-1** and **WEB-2**.",
      permission_requests: [],
    });
    // The token was minted for the person who mentioned the agent, and revoked once the turn ended.
    const [minted] = harness.api.minted;
    expect(minted).toMatchObject({ userId: USER_ID, agentId: AGENT_ID });
    await waitUntil(() => harness!.api.revoked.includes(minted!.tokenId));

    // The same policy as a browser session: pinned cwd, Plane MCP with that token, the channel's level.
    const agent = harness.transport.agents[0]!;
    expect(agent.grant.agent.defaultPermissionLevel).toBe("ask_writes");
    const session = agent.received.find((m) => m.method === "session/new")!;
    expect(session.params).toMatchObject({
      cwd: `/workspaces/${WORKSPACE_ID}/${USER_ID}`,
      mcpServers: [
        {
          type: "http",
          name: "plane",
          url: MCP_URL,
          headers: [
            { name: "Authorization", value: `Bearer ${minted!.token}` },
            { name: "X-Workspace-slug", value: WORKSPACE_SLUG },
          ],
        },
      ],
      _meta: { "plane/initialModeId": "ask_writes" },
    });
    const prompt = agent.received.find((m) => m.method === "session/prompt")!;
    expect(prompt.params!.prompt).toEqual([{ type: "text", text: request().prompt }]);
    expect(agent.received.find((m) => m.method === "initialize")!.params!.clientCapabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    await waitUntil(() => agent.closed);
    await waitUntil(() => harness!.bridge.channelSessionCount === 0);
  });

  it("starts at the channel's level, clamped to the registry maximum", async () => {
    harness = await startHarness({
      agent: { default_permission_level: "ask_all", max_permission_level: "ask_writes" },
    });
    await start(harness, request({ permission_level: "yolo" }));
    await reply(harness);
    const agent = harness.transport.agents[0]!;
    // The spawn ticket's mode and the session's both.
    expect(agent.grant.agent.defaultPermissionLevel).toBe("ask_writes");
    expect(agent.received.find((m) => m.method === "session/new")!.params!._meta).toEqual({
      "plane/initialModeId": "ask_writes",
    });
  });

  it("never runs a channel session above asking for writes, whatever the registry allows", async () => {
    harness = await startHarness({
      agent: { default_permission_level: "yolo", max_permission_level: "yolo" },
    });
    await start(harness, request({ permission_level: "yolo" }));
    await reply(harness);
    const agent = harness.transport.agents[0]!;
    expect(agent.grant.agent.defaultPermissionLevel).toBe("ask_writes");
    // Nor can it switch above that during the session.
    expect(agent.grant.agent.maxPermissionLevel).toBe("ask_writes");
    expect(agent.received.find((m) => m.method === "session/new")!.params!._meta).toEqual({
      "plane/initialModeId": "ask_writes",
    });
  });

  it("refuses every permission prompt and reports what it was for", async () => {
    harness = await startHarness();
    const answers: unknown[] = [];
    harness.transport.script = async (agent) => {
      for (const [title, options] of [
        [
          "edit work item WEB-12",
          [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        ],
        ["delete a page", [{ optionId: "ok", name: "Allow", kind: "allow_always" }]],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one prompt at a time
        const answer = await agent.request("session/request_permission", {
          sessionId: "fake-session-1",
          toolCall: { toolCallId: title, title, kind: "edit", status: "pending" },
          options,
        });
        answers.push(answer.result);
      }
      await agent.update(chunk("I couldn't make the change."));
      return { stopReason: "end_turn" };
    };
    await start(harness);
    expect(await reply(harness)).toMatchObject({
      status: "ok",
      text: "I couldn't make the change.",
      permission_requests: ["edit work item WEB-12", "delete a page"],
    });
    // The reject option where there is one, else cancelled; never an allow.
    expect(answers).toEqual([
      { outcome: { outcome: "selected", optionId: "no" } },
      { outcome: { outcome: "cancelled" } },
    ]);
  });

  it("stops a turn that runs out of time", async () => {
    harness = await startHarness();
    harness.transport.script = () => new Promise(() => undefined);
    await start(harness, request({ timeout_ms: 1_000 }));
    expect(await reply(harness)).toEqual({ run_id: RUN_ID, status: "failed", error: "timeout" });
    const agent = harness.transport.agents[0]!;
    await waitUntil(() => agent.closed);
    await waitUntil(() => harness!.api.revoked.length === 1);
  });

  it("reports a runner that refuses the session", async () => {
    harness = await startHarness();
    harness.transport.fail = true;
    await start(harness);
    expect(await reply(harness)).toEqual({ run_id: RUN_ID, status: "failed", error: "unavailable" });
    // The token minted for it is revoked.
    await waitUntil(() => harness!.api.revoked.length === 1);
    expect(harness.api.revoked).toEqual([harness.api.minted[0]!.tokenId]);
  });

  it("reports an agent without working credentials", async () => {
    harness = await startHarness();
    harness.transport.script = () => Promise.reject({ code: -32_000, message: "Authentication required" });
    await start(harness);
    expect(await reply(harness)).toEqual({ run_id: RUN_ID, status: "failed", error: "credentials" });
  });

  it("reports an agent that fails the turn", async () => {
    harness = await startHarness();
    harness.transport.script = () => Promise.reject({ code: -32_603, message: "boom" });
    await start(harness);
    expect(await reply(harness)).toEqual({ run_id: RUN_ID, status: "failed", error: "failed" });
  });

  it("reports an agent the API won't start (disabled, or the user may not run it)", async () => {
    harness = await startHarness();
    await start(harness, request({ agent_id: "66666666-6666-4666-8666-666666666666" }));
    expect(await reply(harness)).toEqual({ run_id: RUN_ID, status: "failed", error: "failed" });
    expect(harness.transport.agents).toEqual([]);
  });

  it("retries a report the API couldn't take", async () => {
    harness = await startHarness();
    harness.api.replyStatuses.push(503, 502);
    await start(harness);
    expect(await reply(harness)).toMatchObject({ status: "ok" });
  });

  it("requires the shared secret", async () => {
    harness = await startHarness();
    for (const headers of [
      {},
      { "X-Agent-Bridge-Secret": "wrong" },
      { "X-Agent-Bridge-Secret": `${BRIDGE_SECRET}x` },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const response = await start(harness, request(), headers);
      expect(response.status).toBe(403);
    }
    expect(harness.api.minted).toEqual([]);
    expect(harness.transport.agents).toEqual([]);
    expect(harness.log.text()).not.toContain(BRIDGE_SECRET);
  });

  it.each([
    ["no run id", { run_id: undefined }],
    ["a bad run id", { run_id: "../../x" }],
    ["a bad user", { user_id: "ada" }],
    ["an unknown level", { permission_level: "root" }],
    ["no prompt", { prompt: "" }],
    ["a timeout too long", { timeout_ms: 24 * 60 * 60_000 }],
  ])("refuses %s", async (_name, overrides) => {
    harness = await startHarness();
    expect((await start(harness, request(overrides))).status).toBe(400);
    expect(harness.api.minted).toEqual([]);
  });

  it("is not under the public base path", async () => {
    harness = await startHarness();
    const response = await harness.http("/agents/internal/channel-sessions", {
      method: "POST",
      body: request(),
      cookie: null,
      origin: null,
      headers: { "X-Agent-Bridge-Secret": BRIDGE_SECRET },
    });
    expect(response.status).toBe(404);
    expect(harness.api.minted).toEqual([]);
  });

  it("counts against the user's connection cap", async () => {
    harness = await startHarness({ config: { maxConnectionsPerUser: 1 } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const script: PromptScript = async () => {
      await held;
      return { stopReason: "end_turn" };
    };
    harness.transport.script = script;
    expect((await start(harness)).status).toBe(202);
    await waitUntil(() => harness!.transport.agents.length === 1);
    expect((await start(harness, request({ run_id: "f".repeat(32) }))).status).toBe(429);
    // A browser chat for the same user is refused too.
    const client = harness.connect();
    expect(await client.closed()).toBe(4429);
    release();
    await reply(harness);
    await waitUntil(() => harness!.bridge.channelSessionCount === 0);
    expect((await start(harness, request({ run_id: "e".repeat(32) }))).status).toBe(202);
  });

  it("counts against the bridge's capacity", async () => {
    harness = await startHarness({ config: { maxConnections: 1 } });
    harness.transport.script = () => new Promise(() => undefined);
    expect((await start(harness)).status).toBe(202);
    expect((await start(harness, request({ run_id: "f".repeat(32), user_id: WORKSPACE_ID }))).status).toBe(429);
  });

  it("tells the API when shutdown stops a session", async () => {
    harness = await startHarness();
    harness.transport.script = () => new Promise(() => undefined);
    await start(harness);
    await waitUntil(() => harness!.transport.agents.length === 1);
    const agent: FakeAgent = harness.transport.agents[0]!;
    await harness.bridge.close();
    expect(harness.api.replies).toEqual([{ run_id: RUN_ID, status: "failed", error: "unavailable" }]);
    expect(agent.closed).toBe(true);
    expect(harness.api.revoked).toEqual([harness.api.minted[0]!.tokenId]);
  });

  it("never logs the prompt, the answer, the token or the provider env", async () => {
    harness = await startHarness();
    harness.transport.script = async (agent) => {
      await agent.update(chunk("the secret answer"));
      return { stopReason: "end_turn" };
    };
    await start(harness);
    await reply(harness);
    await waitUntil(() => harness!.api.revoked.length === 1);
    const logged = harness.log.text();
    expect(logged).not.toContain("what's left for the release");
    expect(logged).not.toContain("the secret answer");
    expect(logged).not.toContain(harness.api.minted[0]!.token);
    expect(logged).not.toContain("sk-ant-never-log-me");
  });
});
