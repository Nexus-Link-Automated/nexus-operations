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

const RUN_A = "a".repeat(32);
const RUN_B = "b".repeat(32);
const CHANNEL_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_CHANNEL_ID = "88888888-8888-4888-8888-888888888888";
const SECRET = { "X-Agent-Bridge-Secret": BRIDGE_SECRET };

function turn(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_A,
    channel_id: CHANNEL_ID,
    user_id: USER_ID,
    workspace_slug: WORKSPACE_SLUG,
    agent_id: AGENT_ID,
    permission_level: "ask_writes",
    prompt: "And what about WEB-3?",
    primer: "Earlier: Ada asked about the release.\n\nAnd what about WEB-3?",
    session_ref: null,
    timeout_ms: 5_000,
    ...overrides,
  };
}

async function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = SECRET) {
  return h.http(path, { method: "POST", body, cookie: null, origin: null, headers });
}

const start = (h: Harness, body: Record<string, unknown> = turn()) => post(h, "/internal/dm-turns", body);

const answer = (h: Harness, requestId: string, body: Record<string, unknown>, channelId = CHANNEL_ID) =>
  post(h, `/internal/dm-turns/${channelId}/permissions/${requestId}`, body);

const cancel = (h: Harness, runId: string, channelId = CHANNEL_ID) =>
  post(h, `/internal/dm-turns/${channelId}/cancel`, { run_id: runId });

async function reportFor(h: Harness, runId: string): Promise<Record<string, unknown>> {
  return waitUntil(() => h.api.replies.find((reply) => reply.run_id === runId));
}

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const promptTexts = (agent: FakeAgent) =>
  agent.requests("session/prompt").map((m) => (m.params!.prompt as { text: string }[])[0]!.text);

const answering: PromptScript = async (agent, prompt) => {
  const text = (prompt.params!.prompt as { text: string }[])[0]!.text;
  await agent.update(chunk(`You said: ${text.split("\n").at(-1)}`));
  return { stopReason: "end_turn" };
};

/** A permission prompt from the agent; resolves with the client's answer. */
async function askPermission(agent: FakeAgent) {
  const response = await agent.request("session/request_permission", {
    sessionId: "fake-session-1",
    toolCall: { toolCallId: "t1", title: "Edit work item WEB-3", kind: "edit", status: "pending" },
    options: [
      { optionId: "yes", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  });
  return response.result;
}

describe("POST /internal/dm-turns", () => {
  it("holds the session between turns, as the DM's person, with the same policy as a browser chat", async () => {
    harness = await startHarness();
    harness.transport.script = answering;
    expect((await start(harness)).status).toBe(202);
    expect(await reportFor(harness, RUN_A)).toEqual({
      run_id: RUN_A,
      status: "ok",
      text: "You said: And what about WEB-3?",
      permission_requests: [],
      tool_calls: [],
      session_ref: "fake-session-1",
      stop_reason: "end_turn",
    });
    expect(harness.bridge.dmSessionCount).toBe(1);

    expect(
      (await start(harness, turn({ run_id: RUN_B, prompt: "Thanks!", session_ref: "fake-session-1" }))).status
    ).toBe(202);
    expect(await reportFor(harness, RUN_B)).toMatchObject({ status: "ok", text: "You said: Thanks!" });

    // One agent, one token, one session: the second turn only prompted.
    expect(harness.transport.agents).toHaveLength(1);
    expect(harness.api.minted).toHaveLength(1);
    const [minted] = harness.api.minted;
    expect(minted).toMatchObject({ userId: USER_ID, agentId: AGENT_ID });
    expect(harness.api.revoked).toEqual([]);
    const agent = harness.transport.agents[0]!;
    expect(agent.requests("initialize")).toHaveLength(1);
    expect(agent.requests("session/new")).toHaveLength(1);
    expect(agent.requests("session/load")).toHaveLength(0);
    // The first turn of a new session gets the primer; later ones only the new message.
    expect(promptTexts(agent)).toEqual([turn().primer, "Thanks!"]);
    expect(agent.requests("session/new")[0]!.params).toMatchObject({
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
    expect(agent.requests("initialize")[0]!.params!.clientCapabilities).toMatchObject({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    const health = await harness.http("/agents/health", { cookie: null, origin: null });
    expect(health.body.dmSessions).toBe(1);
  });

  it("loads the DM's session when the agent can, without taking the replayed history as the answer", async () => {
    harness = await startHarness();
    harness.transport.options.loadReplay = ["an answer from last week"];
    harness.transport.script = answering;
    await start(harness, turn({ session_ref: "session-from-last-week" }));
    expect(await reportFor(harness, RUN_A)).toMatchObject({
      status: "ok",
      text: "You said: And what about WEB-3?",
      session_ref: "session-from-last-week",
    });
    const agent = harness.transport.agents[0]!;
    expect(agent.requests("session/load")[0]!.params).toMatchObject({
      sessionId: "session-from-last-week",
      cwd: `/workspaces/${WORKSPACE_ID}/${USER_ID}`,
    });
    expect(agent.requests("session/new")).toHaveLength(0);
    expect(promptTexts(agent)).toEqual([turn().prompt]);
  });

  it("starts a new session primed with the history when loading fails", async () => {
    harness = await startHarness();
    harness.transport.options.failLoad = true;
    harness.transport.script = answering;
    await start(harness, turn({ session_ref: "gone-session" }));
    expect(await reportFor(harness, RUN_A)).toMatchObject({ status: "ok", session_ref: "fake-session-1" });
    const agent = harness.transport.agents[0]!;
    expect(agent.requests("session/load")).toHaveLength(1);
    expect(agent.requests("session/new")).toHaveLength(1);
    expect(promptTexts(agent)).toEqual([turn().primer]);
  });

  it("starts a new session primed with the history when the agent can't load sessions", async () => {
    harness = await startHarness();
    harness.transport.options.loadSession = false;
    harness.transport.script = answering;
    await start(harness, turn({ session_ref: "fake-session-0" }));
    expect(await reportFor(harness, RUN_A)).toMatchObject({ status: "ok", session_ref: "fake-session-1" });
    const agent = harness.transport.agents[0]!;
    expect(agent.requests("session/load")).toHaveLength(0);
    expect(promptTexts(agent)).toEqual([turn().primer]);
  });

  it("changes a held session's level when the DM's level changed", async () => {
    harness = await startHarness();
    harness.transport.script = answering;
    await start(harness);
    await reportFor(harness, RUN_A);
    await start(harness, turn({ run_id: RUN_B, permission_level: "ask_all" }));
    await reportFor(harness, RUN_B);
    const agent = harness.transport.agents[0]!;
    expect(agent.requests("session/set_mode").map((m) => m.params)).toEqual([
      { sessionId: "fake-session-1", modeId: "ask_all" },
    ]);
  });

  it("closes a session that stays idle, revoking its token and freeing its slot", async () => {
    harness = await startHarness({ config: { dmIdleTimeoutMs: 300, maxConnectionsPerUser: 1 } });
    harness.transport.script = answering;
    await start(harness);
    await reportFor(harness, RUN_A);
    const agent = harness.transport.agents[0]!;
    await waitUntil(() => agent.closed);
    await waitUntil(() => harness!.api.revoked.includes(harness!.api.minted[0]!.tokenId));
    expect(harness.bridge.dmSessionCount).toBe(0);
    // The slot is free again: a browser chat for the same person opens.
    const client = await harness.open();
    expect(client.closeCode).toBeUndefined();
  });

  it("streams the reply as throttled drafts", async () => {
    harness = await startHarness({ dm: { draftIntervalMs: 200, draftChars: 2_048 } });
    harness.transport.script = async (agent) => {
      await agent.update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "List work items", status: "pending" });
      for (let i = 0; i < 12; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one chunk at a time
        await agent.update(chunk(`word${i} `));
        // oxlint-disable-next-line no-await-in-loop -- spread out
        await sleep(50);
      }
      await agent.update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      return { stopReason: "end_turn" };
    };
    const startedAt = Date.now();
    await start(harness);
    const report = await reportFor(harness, RUN_A);
    const elapsed = Date.now() - startedAt;
    const drafts = harness.api.drafts;
    // The first change at once, then at most one per interval.
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.length).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 1);
    expect(drafts[0]).toEqual({
      run_id: RUN_A,
      text: "",
      tool_calls: [{ id: "t1", title: "List work items", status: "pending" }],
    });
    // Each draft has everything so far.
    const texts = drafts.map((draft) => String(draft.text));
    for (let i = 1; i < texts.length; i += 1) expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true);
    expect(String(report.text).startsWith(texts.at(-1)!)).toBe(true);
    expect(report.tool_calls).toEqual([{ id: "t1", title: "List work items", status: "completed" }]);
  });

  it("posts a draft at once when 2 KB of new text has piled up", async () => {
    harness = await startHarness({ dm: { draftIntervalMs: 60_000, draftChars: 2_048 } });
    harness.transport.script = async (agent) => {
      await agent.update(chunk("Here goes: "));
      await waitUntil(() => harness!.api.drafts.length === 1);
      await agent.update(chunk("x".repeat(2_100)));
      await waitUntil(() => harness!.api.drafts.length === 2);
      await agent.update(chunk(" done."));
      return { stopReason: "end_turn" };
    };
    await start(harness);
    const report = await reportFor(harness, RUN_A);
    expect(harness.api.drafts.map((draft) => String(draft.text).length)).toEqual([11, 2_111]);
    expect(report.text).toBe(`Here goes: ${"x".repeat(2_100)} done.`);
  });

  it("asks the DM's person about a permission prompt and answers the agent with their choice", async () => {
    harness = await startHarness();
    const answers: unknown[] = [];
    harness.transport.script = async (agent) => {
      answers.push(await askPermission(agent));
      await agent.update(chunk("Done."));
      return { stopReason: "end_turn" };
    };
    await start(harness);
    const prompt = await waitUntil(() => harness!.api.permissions[0]);
    expect(prompt).toEqual({
      run_id: RUN_A,
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      title: "Edit work item WEB-3",
      options: [
        { option_id: "yes", name: "Allow once", kind: "allow_once" },
        { option_id: "always", name: "Always allow", kind: "allow_always" },
        { option_id: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const requestId = String(prompt.request_id);
    // Only that run's prompt, and only one of its options.
    expect((await answer(harness, requestId, { run_id: RUN_B, option_id: "yes" })).status).toBe(404);
    expect((await answer(harness, "c".repeat(32), { run_id: RUN_A, option_id: "yes" })).status).toBe(404);
    expect((await answer(harness, requestId, { run_id: RUN_A, option_id: "yes" }, OTHER_CHANNEL_ID)).status).toBe(404);
    expect((await answer(harness, requestId, { run_id: RUN_A, option_id: "maybe" })).status).toBe(400);
    expect((await answer(harness, requestId, { run_id: RUN_A, option_id: "always" })).status).toBe(204);
    // Answered once only.
    expect((await answer(harness, requestId, { run_id: RUN_A, option_id: "no" })).status).toBe(404);
    expect(await reportFor(harness, RUN_A)).toMatchObject({ status: "ok", text: "Done." });
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "always" } }]);
  });

  it("rejects a prompt nobody answered when the turn runs out of time", async () => {
    harness = await startHarness();
    const answers: unknown[] = [];
    harness.transport.script = async (agent) => {
      answers.push(await askPermission(agent));
      return new Promise(() => undefined);
    };
    await start(harness, turn({ timeout_ms: 1_000 }));
    const prompt = await waitUntil(() => harness!.api.permissions[0]);
    expect(await reportFor(harness, RUN_A)).toEqual({
      run_id: RUN_A,
      status: "failed",
      error: "timeout",
      text: "",
      tool_calls: [],
      session_ref: "fake-session-1",
    });
    await waitUntil(() => answers.length === 1);
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }]);
    expect((await answer(harness, String(prompt.request_id), { run_id: RUN_A, option_id: "yes" })).status).toBe(404);
    // A turn that didn't finish leaves nothing held.
    const agent = harness.transport.agents[0]!;
    await waitUntil(() => agent.closed);
    await waitUntil(() => harness!.api.revoked.length === 1);
    expect(harness.bridge.dmSessionCount).toBe(0);
  });

  it("refuses the prompt at once when the API won't ask anyone", async () => {
    harness = await startHarness();
    harness.api.permissionStatuses.push(409);
    const answers: unknown[] = [];
    harness.transport.script = async (agent) => {
      answers.push(await askPermission(agent));
      return { stopReason: "end_turn" };
    };
    await start(harness);
    expect(await reportFor(harness, RUN_A)).toMatchObject({ status: "failed" });
    expect(answers).toEqual([{ outcome: { outcome: "selected", optionId: "no" } }]);
  });

  it("stops a turn: session/cancel, waiting prompts cancelled, and the reply so far", async () => {
    harness = await startHarness();
    const answers: unknown[] = [];
    harness.transport.script = async (agent) => {
      await agent.update(chunk("Working on it"));
      answers.push(await askPermission(agent));
      await waitUntil(() => agent.cancelled);
      return { stopReason: "cancelled" };
    };
    await start(harness);
    await waitUntil(() => harness!.api.permissions[0]);
    expect((await cancel(harness, RUN_B)).status).toBe(404);
    expect((await cancel(harness, RUN_A, OTHER_CHANNEL_ID)).status).toBe(404);
    expect((await cancel(harness, RUN_A)).status).toBe(202);
    expect(await reportFor(harness, RUN_A)).toMatchObject({
      status: "ok",
      text: "Working on it",
      stop_reason: "cancelled",
    });
    expect(answers).toEqual([{ outcome: { outcome: "cancelled" } }]);
    const agent = harness.transport.agents[0]!;
    expect(agent.received.find((m) => m.method === "session/cancel")!.params).toEqual({ sessionId: "fake-session-1" });
    // Once the report is in, the turn is gone.
    for (let tries = 0; tries < 100 && (await cancel(harness, RUN_A)).status !== 404; tries++) await sleep(10);
    expect((await cancel(harness, RUN_A)).status).toBe(404);
    // A stopped turn keeps the session for the next message.
    expect(harness.bridge.dmSessionCount).toBe(1);
    expect(agent.closed).toBe(false);
  });

  it("takes a Stop for a turn that has finished but is still reporting, so its reply isn't lost", async () => {
    harness = await startHarness();
    harness.api.replyStatuses.push(503);
    harness.transport.script = answering;
    await start(harness);
    // The first report failed, and the turn waits to send it again.
    await waitUntil(() => harness!.api.replyStatuses.length === 0);
    expect((await cancel(harness, RUN_A)).status).toBe(202);
    expect(await reportFor(harness, RUN_A)).toMatchObject({
      status: "ok",
      text: "You said: And what about WEB-3?",
    });
  });

  it("stops a turn the API won't take drafts for any more", async () => {
    harness = await startHarness();
    harness.api.draftStatuses.push(409);
    harness.transport.script = async (agent) => {
      await agent.update(chunk("Hello"));
      await waitUntil(() => agent.cancelled);
      return { stopReason: "cancelled" };
    };
    await start(harness);
    expect(await reportFor(harness, RUN_A)).toMatchObject({ status: "failed", error: "failed", text: "Hello" });
    const agent = harness.transport.agents[0]!;
    expect(agent.cancelled).toBe(true);
    await waitUntil(() => agent.closed);
    await waitUntil(() => harness!.api.revoked.length === 1);
  });

  it("runs one turn at a time per DM", async () => {
    harness = await startHarness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.transport.script = async () => {
      await held;
      return { stopReason: "end_turn" };
    };
    expect((await start(harness)).status).toBe(202);
    expect((await start(harness, turn({ run_id: RUN_B }))).status).toBe(409);
    expect((await start(harness, turn({ run_id: RUN_B, channel_id: OTHER_CHANNEL_ID }))).status).toBe(202);
    release();
    await reportFor(harness, RUN_A);
    await reportFor(harness, RUN_B);
  });

  it("counts held sessions against the caps shared with browser chats", async () => {
    harness = await startHarness({ config: { maxConnectionsPerUser: 2 } });
    harness.transport.script = answering;
    await harness.open();
    expect((await start(harness)).status).toBe(202);
    await reportFor(harness, RUN_A);
    // Still held after the turn, so it still takes a slot.
    expect((await start(harness, turn({ run_id: RUN_B, channel_id: OTHER_CHANNEL_ID }))).status).toBe(429);
    const client = harness.connect();
    expect(await client.closed()).toBe(4429);
    // A turn on the held session needs no new slot.
    expect((await start(harness, turn({ run_id: RUN_B }))).status).toBe(202);
    await reportFor(harness, RUN_B);
  });

  it("counts against the bridge's capacity", async () => {
    harness = await startHarness({ config: { maxConnections: 1 } });
    harness.transport.script = answering;
    await start(harness);
    await reportFor(harness, RUN_A);
    expect((await start(harness, turn({ run_id: RUN_B, channel_id: OTHER_CHANNEL_ID }))).status).toBe(429);
  });

  it("reports a runner that refuses the session and frees the slot", async () => {
    harness = await startHarness({ config: { maxConnectionsPerUser: 1 } });
    harness.transport.fail = true;
    await start(harness);
    expect(await reportFor(harness, RUN_A)).toEqual({
      run_id: RUN_A,
      status: "failed",
      error: "unavailable",
      text: "",
      tool_calls: [],
      session_ref: null,
    });
    harness.transport.fail = false;
    harness.transport.script = answering;
    await waitUntil(() => harness!.api.revoked.length === 1);
    expect((await start(harness, turn({ run_id: RUN_B }))).status).toBe(202);
    await reportFor(harness, RUN_B);
  });

  it("tells the API about a running turn on shutdown, and closes held sessions", async () => {
    harness = await startHarness();
    harness.transport.script = answering;
    await start(harness, turn({ channel_id: OTHER_CHANNEL_ID }));
    await reportFor(harness, RUN_A);
    harness.transport.script = () => new Promise(() => undefined);
    await start(harness, turn({ run_id: RUN_B }));
    await waitUntil(
      () =>
        harness!.transport.agents.length === 2 && harness!.transport.agents[1]!.requests("session/prompt").length === 1
    );
    await harness.bridge.close();
    expect(harness.api.replies.find((reply) => reply.run_id === RUN_B)).toMatchObject({
      status: "failed",
      error: "unavailable",
    });
    expect(harness.transport.agents.every((agent) => agent.closed)).toBe(true);
    expect(harness.api.revoked.toSorted()).toEqual(harness.api.minted.map((m) => m.tokenId).toSorted());
  });

  it("requires the shared secret on every route", async () => {
    harness = await startHarness();
    for (const [path, body] of [
      ["/internal/dm-turns", turn()],
      [`/internal/dm-turns/${CHANNEL_ID}/permissions/${"c".repeat(32)}`, { run_id: RUN_A, option_id: "yes" }],
      [`/internal/dm-turns/${CHANNEL_ID}/cancel`, { run_id: RUN_A }],
    ] as const) {
      for (const headers of [{}, { "X-Agent-Bridge-Secret": "wrong" }]) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        expect((await post(harness, path, body, headers)).status).toBe(403);
      }
    }
    expect(harness.api.minted).toEqual([]);
    expect(harness.log.text()).not.toContain(BRIDGE_SECRET);
  });

  it("is not under the public base path", async () => {
    harness = await startHarness();
    for (const path of ["/agents/internal/dm-turns", `/agents/internal/dm-turns/${CHANNEL_ID}/cancel`]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      expect((await post(harness, path, turn())).status).toBe(404);
    }
    expect(harness.api.minted).toEqual([]);
  });

  it.each([
    ["a bad channel", { channel_id: "general" }],
    ["no primer", { primer: "" }],
    ["a session ref too long", { session_ref: "s".repeat(256) }],
    ["an unknown level", { permission_level: "root" }],
    ["a bad run id", { run_id: "x" }],
  ])("refuses %s", async (_name, overrides) => {
    harness = await startHarness();
    expect((await start(harness, turn(overrides))).status).toBe(400);
    expect(harness.api.minted).toEqual([]);
  });

  it("never logs the prompt, the answer, the token or the provider env", async () => {
    harness = await startHarness();
    harness.transport.script = async (agent) => {
      await agent.update(chunk("the secret answer"));
      return { stopReason: "end_turn" };
    };
    await start(harness);
    await reportFor(harness, RUN_A);
    const logged = harness.log.text();
    expect(logged).not.toContain("WEB-3");
    expect(logged).not.toContain("the secret answer");
    expect(logged).not.toContain(harness.api.minted[0]!.token);
    expect(logged).not.toContain("sk-ant-never-log-me");
  });
});
