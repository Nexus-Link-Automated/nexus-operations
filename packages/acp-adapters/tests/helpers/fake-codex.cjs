#!/usr/bin/env node
// Fake `codex app-server` for the Codex adapter tests, ported from employ_ai's FakeCodexProcess
// (tests/codex-app-server-client.test.ts). It speaks the app-server's newline-delimited JSON-RPC
// over stdio and is driven by the prompt text:
//   "hello" streams reasoning + a message; "run" asks to run a command; "search" asks to run a
//   command Codex's display parser labels a search; "ls" asks to run a read-only command; "cmd
//   <command>" asks to run that command; "cat etc" / "cat creds" ask to read a file outside the cwd /
//   a sign-in file; "patch <file>..." starts a file change and asks to apply it; "plane" / "plane
//   list" ask to call a Plane MCP tool; "wait" streams one delta then waits for turn/interrupt;
//   "wait tool" starts a command then waits for turn/interrupt; anything else answers "ok".
// Every message it receives is appended to $FAKE_CODEX_LOG (JSONL) so tests can assert on
// thread/start params, approval replies and approval policies; the first line of each run is
// `{ start: { codexHome, apiKeyInEnv }, argv }`.
// Accounts: signed in with an API key unless FAKE_CODEX_SIGNED_IN=0; FAKE_CODEX_ACCOUNT=chatgpt
// signs in with ChatGPT instead. `account/login/start {type: "chatgptDeviceCode"}` completes after
// a moment (FAKE_CODEX_LOGIN=fail fails it, =hang never completes) and writes $CODEX_HOME/auth.json.
// FAKE_CODEX_APPROVAL_PAUSE_MS: stay silent this long after an approval answer before going on.
// FAKE_CODEX_TURN_START_DELAY_MS: hold the `turn/start` response this long.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const log = process.env.FAKE_CODEX_LOG;
const chatgpt = { type: "chatgpt", email: "dev@example.com", planType: "plus", workspaceName: null };
let signedIn = process.env.FAKE_CODEX_SIGNED_IN !== "0";
let account = process.env.FAKE_CODEX_ACCOUNT === "chatgpt" ? chatgpt : { type: "apiKey" };
let buffer = "";
let nextServerRequest = 1;
const pendingReplies = new Map();
let activeTurn;
let turnCount = 0;
let threadCwd = "/work";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
}

function notify(method, params) {
  send({ method, params: { threadId: "thread-1", ...params } });
}

function ask(method, params) {
  const id = `srv-${nextServerRequest++}`;
  send({ id, method, params: { threadId: "thread-1", turnId: activeTurn, ...params } });
  return new Promise((resolve) => pendingReplies.set(id, resolve));
}

function message(itemId, text) {
  notify("item/started", { turnId: activeTurn, item: { type: "agentMessage", id: itemId, text: "" } });
  notify("item/agentMessage/delta", { turnId: activeTurn, itemId, delta: text });
  notify("item/completed", { turnId: activeTurn, item: { type: "agentMessage", id: itemId, text } });
}

function complete(status = "completed") {
  notify("thread/tokenUsage/updated", {
    turnId: activeTurn,
    tokenUsage: {
      total: {
        totalTokens: 120,
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
      last: {
        totalTokens: 120,
        inputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
      modelContextWindow: 400000,
    },
  });
  notify("turn/completed", { turn: { id: activeTurn, status, error: null, items: [] } });
  activeTurn = undefined;
}

async function runTurn(text) {
  const n = turnCount;
  if (text === "hello") {
    notify("item/reasoning/summaryTextDelta", {
      turnId: activeTurn,
      itemId: `r-${n}`,
      delta: "Thinking.",
      summaryIndex: 0,
    });
    notify("item/agentMessage/delta", { turnId: activeTurn, itemId: `m-${n}`, delta: "Hi " });
    notify("item/agentMessage/delta", { turnId: activeTurn, itemId: `m-${n}`, delta: "there" });
    notify("item/completed", { turnId: activeTurn, item: { type: "agentMessage", id: `m-${n}`, text: "Hi there" } });
    complete();
    return;
  }
  if (text.startsWith("patch ")) {
    const itemId = `patch-${n}`;
    const changes = text
      .split(" ")
      .slice(1)
      .map((file) => ({ path: file, kind: { type: "update", move_path: null }, diff: "+x\n" }));
    const item = { type: "fileChange", id: itemId, changes };
    notify("item/started", { turnId: activeTurn, item: { ...item, status: "inProgress" } });
    const reply = await ask("item/fileChange/requestApproval", {
      itemId,
      startedAtMs: 0,
      reason: null,
      grantRoot: null,
    });
    const accepted = reply.result && reply.result.decision === "accept";
    notify("item/completed", {
      turnId: activeTurn,
      item: { ...item, status: accepted ? "completed" : "declined" },
    });
    message(`m-${n}`, accepted ? "patched" : "skipped");
    complete();
    return;
  }
  if (
    text === "run" ||
    text === "search" ||
    text === "ls" ||
    text === "cat etc" ||
    text === "cat creds" ||
    text.startsWith("cmd ")
  ) {
    const reads = {
      "cat etc": "/etc/hostname",
      "cat creds": path.join(process.env.HOME || "/tmp", ".codex", "auth.json"),
    };
    const command =
      text === "run"
        ? "touch a.txt"
        : text === "search"
          ? "find . -name x -delete"
          : text === "ls"
            ? "ls"
            : text in reads
              ? `cat ${reads[text]}`
              : text.slice(4);
    const itemId = `cmd-${n}`;
    const askingTurn = activeTurn;
    const reply = await ask("item/commandExecution/requestApproval", {
      itemId,
      startedAtMs: 0,
      environmentId: null,
      kind: "command",
      command,
      // The real server reports the command's own directory; only `run` keeps a fixed one for the goldens.
      cwd: text === "run" ? "/work" : threadCwd,
      commandActions:
        text === "search"
          ? [{ type: "search", command, query: "x", path: "." }]
          : text === "ls"
            ? [{ type: "listFiles", command, path: null }]
            : text in reads
              ? [{ type: "read", command, name: path.basename(reads[text]), path: reads[text] }]
              : [{ type: "unknown", command }],
    });
    const pauseMs = Number(process.env.FAKE_CODEX_APPROVAL_PAUSE_MS);
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    // Interrupted while waiting: nothing of this turn may be reported under a later turn's id.
    if (activeTurn !== askingTurn) return;
    if (reply.result && reply.result.decision === "accept") {
      notify("item/started", {
        turnId: activeTurn,
        item: { type: "commandExecution", id: itemId, command, cwd: "/work", status: "inProgress", commandActions: [] },
      });
      notify("item/completed", {
        turnId: activeTurn,
        item: {
          type: "commandExecution",
          id: itemId,
          command,
          cwd: "/work",
          status: "completed",
          aggregatedOutput: "done\n",
          exitCode: 0,
          commandActions: [],
        },
      });
      message(`m-${n}`, "ran it");
    } else {
      message(`m-${n}`, "skipped");
    }
    complete();
    return;
  }
  if (text === "plane" || text === "plane list") {
    const toolParams = text === "plane" ? { action: "create", name: "T" } : { action: "list" };
    const reply = await ask("mcpServer/elicitation/request", {
      serverName: "plane",
      mode: "form",
      message: "Allow the plane MCP server to run tool workitem?",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_name: "workitem",
        tool_params: toolParams,
      },
    });
    if (reply.result && reply.result.action === "accept") {
      const item = {
        type: "mcpToolCall",
        id: `mcp-${n}`,
        server: "plane",
        tool: "workitem",
        arguments: toolParams,
      };
      notify("item/started", {
        turnId: activeTurn,
        item: { ...item, status: "inProgress", result: null, error: null },
      });
      notify("item/completed", {
        turnId: activeTurn,
        item: {
          ...item,
          status: "completed",
          result: { content: [{ type: "text", text: "created T" }], structuredContent: null, _meta: null },
          error: null,
        },
      });
      message(`m-${n}`, "created");
    } else {
      message(`m-${n}`, "not created");
    }
    complete();
    return;
  }
  if (text === "wait tool") {
    const item = { type: "commandExecution", id: `cmd-${n}`, command: "sleep 60", cwd: "/work", commandActions: [] };
    notify("item/started", { turnId: activeTurn, item: { ...item, status: "inProgress" } });
    return; // completes on turn/interrupt, without reporting the item's end
  }
  if (text === "wait") {
    notify("item/agentMessage/delta", { turnId: activeTurn, itemId: `m-${n}`, delta: "working" });
    return; // completes on turn/interrupt
  }
  message(`m-${n}`, "ok");
  complete();
}

function handle(msg) {
  if (log) fs.appendFileSync(log, `${JSON.stringify(msg)}\n`);
  if (msg.id !== undefined && !msg.method) {
    const resolve = pendingReplies.get(msg.id);
    pendingReplies.delete(msg.id);
    if (resolve) resolve(msg);
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { userAgent: "fake-codex/0.166.0" } });
      return;
    case "account/read":
      send({ id: msg.id, result: { account: signedIn ? account : null, requiresOpenaiAuth: true } });
      return;
    case "account/login/start":
      if (msg.params && msg.params.type === "chatgptDeviceCode") {
        send({
          id: msg.id,
          result: {
            type: "chatgptDeviceCode",
            loginId: "login-1",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-1234",
          },
        });
        if (process.env.FAKE_CODEX_LOGIN === "hang") return;
        setTimeout(() => {
          const success = process.env.FAKE_CODEX_LOGIN !== "fail";
          if (success) {
            signedIn = true;
            account = chatgpt;
            fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), "{}");
          }
          send({
            method: "account/login/completed",
            params: { loginId: "login-1", success, error: success ? null : "device code expired" },
          });
        }, 50);
        return;
      }
      signedIn = msg.params && msg.params.type === "apiKey" && Boolean(msg.params.apiKey);
      account = { type: "apiKey" };
      send({ id: msg.id, result: { type: "apiKey" } });
      return;
    case "account/login/cancel":
      send({ id: msg.id, result: { status: "canceled" } });
      return;
    case "model/list":
      send({
        id: msg.id,
        result: {
          data: [
            {
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              description: "Test model",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Fast" },
                { reasoningEffort: "medium", description: "" },
                { reasoningEffort: "high", description: "Thorough" },
              ],
              defaultReasoningEffort: "medium",
            },
            { id: "gpt-mini", model: "gpt-mini", displayName: "GPT Mini", description: "", hidden: false },
            { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", description: "", hidden: true },
          ],
          nextCursor: null,
        },
      });
      return;
    case "thread/start":
      threadCwd = msg.params.cwd;
      send({
        id: msg.id,
        result: {
          thread: { id: "thread-1" },
          model: "gpt-test",
          reasoningEffort: process.env.FAKE_CODEX_REASONING_EFFORT || null,
        },
      });
      notify("mcpServer/startupStatus/updated", {
        name: "broken",
        status: process.env.FAKE_CODEX_BROKEN_MCP ? "failed" : "ready",
        error: null,
      });
      return;
    case "turn/start": {
      turnCount += 1;
      activeTurn = `turn-${turnCount}`;
      const text = (msg.params.input[0] && msg.params.input[0].text) || "";
      const started = () => {
        send({ id: msg.id, result: { turn: { id: activeTurn, status: "inProgress", items: [] } } });
        setImmediate(() => void runTurn(text));
      };
      const delayMs = Number(process.env.FAKE_CODEX_TURN_START_DELAY_MS);
      if (delayMs) setTimeout(started, delayMs);
      else started();
      return;
    }
    case "turn/interrupt":
      send({ id: msg.id, result: {} });
      if (activeTurn) complete("interrupted");
      return;
    default:
      if (msg.id !== undefined && msg.method)
        send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}

if (log) {
  fs.appendFileSync(
    log,
    `${JSON.stringify({ start: { codexHome: process.env.CODEX_HOME, apiKeyInEnv: "OPENAI_API_KEY" in process.env }, argv: process.argv.slice(2) })}\n`
  );
  fs.appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
