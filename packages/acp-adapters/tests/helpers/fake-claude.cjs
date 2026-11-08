#!/usr/bin/env node
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Fake Claude Code CLI for tests that run the real Agent SDK. It speaks the SDK's stream-json
// protocol over stdio and appends one JSON line per start to $FAKE_CLAUDE_LOG: its command line as
// the kernel exposes it, and what it found at the `--mcp-config` path. The prompt "hang" never
// finishes starting up (no `system/init`); anything else is answered with an empty result.
"use strict";

const fs = require("node:fs");

const sessionId = "00000000-0000-4000-8000-000000000002";
const cmdline = fs.readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);

function readMcpConfig() {
  const index = cmdline.indexOf("--mcp-config");
  if (index < 0) return undefined;
  const file = cmdline[index + 1];
  return {
    path: file,
    mode: fs.statSync(file).mode & 0o777,
    content: JSON.parse(fs.readFileSync(file, "utf8")),
  };
}

fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ cmdline, mcpConfig: readMcpConfig() })}\n`);

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(message) {
  if (message.type === "control_request") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: {} },
    });
    return;
  }
  if (message.type !== "user" || message.message.content[0].text === "hang") return;
  send({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), tools: [], mcp_servers: [] });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: sessionId,
  });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
