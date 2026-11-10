/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { AgentContext } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { describeClaudeTool } from "../src/claude/index.ts";
import { approvalPolicyFor, commandCategory } from "../src/codex/index.ts";
import { describeGeminiToolCall } from "../src/gemini/index.ts";
import {
  PERMISSION_MODE_IDS,
  classifyMcpCall,
  initialModeId,
  requiresPermission,
  sessionModeState,
  type ToolCategory,
} from "../src/core/modes.ts";
import { PermissionGate, fileMemory, permissionOptions, shellCommandMemory } from "../src/core/permission.ts";

const ALL: readonly ToolCategory[] = [
  "read",
  "search",
  "read_outside",
  "fetch",
  "think",
  "execute",
  "edit",
  "delete",
  "move",
  "mcp_read",
  "mcp_write",
  "other",
];

describe("mode gate", () => {
  it("advertises exactly the three levels, least to most permissive", () => {
    expect(PERMISSION_MODE_IDS).toEqual(["ask_all", "ask_writes", "yolo"]);
    expect(sessionModeState("yolo").availableModes.map((mode) => mode.id)).toEqual(["ask_all", "ask_writes", "yolo"]);
    expect(sessionModeState("yolo").currentModeId).toBe("yolo");
  });

  it("ask_writes lets reads, searches and Plane reads through", () => {
    for (const category of ["read", "search", "think", "mcp_read"] as const) {
      expect(requiresPermission("ask_writes", category), category).toBe(false);
    }
  });

  it("ask_writes prompts for reads outside the cwd, web fetches, shell, writes and Plane MCP mutations", () => {
    for (const category of [
      "read_outside",
      "fetch",
      "execute",
      "edit",
      "delete",
      "move",
      "mcp_write",
      "other",
    ] as const) {
      expect(requiresPermission("ask_writes", category), category).toBe(true);
    }
  });

  it("yolo never prompts and ask_all always does", () => {
    for (const category of ALL) {
      expect(requiresPermission("yolo", category), category).toBe(false);
      expect(requiresPermission("ask_all", category), category).toBe(true);
    }
  });

  it("starts in the mode the bridge requests, then the env default, then ask_writes", () => {
    expect(initialModeId({ "plane/initialModeId": "yolo" }, { PLANE_AGENT_DEFAULT_MODE: "ask_all" })).toBe("yolo");
    expect(initialModeId({ "plane/initialModeId": "bogus" }, { PLANE_AGENT_DEFAULT_MODE: "ask_all" })).toBe("ask_all");
    expect(initialModeId(undefined, {})).toBe("ask_writes");
  });
});

describe("MCP call classification", () => {
  it("follows the Plane MCP action convention and fails closed", () => {
    for (const action of ["list", "list_archived", "retrieve", "retrieve_by_identifier", "search", "count", "get"]) {
      expect(classifyMcpCall("workitem", { action }), action).toBe("mcp_read");
    }
    for (const action of ["create", "update", "delete", "archive", "manage_label", "resolve", "something_new"]) {
      expect(classifyMcpCall("workitem", { action }), action).toBe("mcp_write");
    }
    expect(classifyMcpCall("get_pql_reference", {})).toBe("mcp_read");
    expect(classifyMcpCall("workitem", {})).toBe("mcp_write");
    expect(classifyMcpCall("anything", { action: "create" }, { readOnlyHint: true })).toBe("mcp_read");
  });
});

describe("provider mappings", () => {
  it("maps permission levels to Codex approval policies", () => {
    expect(approvalPolicyFor("ask_all")).toBe("untrusted");
    expect(approvalPolicyFor("ask_writes")).toBe("untrusted");
    expect(approvalPolicyFor("yolo")).toBe("on-request");
  });

  it("labels a Codex command's card from its parsed actions", () => {
    expect(commandCategory([{ type: "read" }])).toBe("read");
    expect(commandCategory([{ type: "listFiles" }, { type: "search" }])).toBe("search");
    expect(commandCategory([{ type: "read" }, { type: "unknown" }])).toBe("execute");
    expect(commandCategory([])).toBe("execute");
  });

  it("classifies Claude Code tools", () => {
    expect(describeClaudeTool("Read", { file_path: "a.ts" }, "/w")).toMatchObject({
      category: "read",
      locations: [{ path: "/w/a.ts" }],
    });
    expect(describeClaudeTool("Bash", { command: "git status" }, "/w")).toMatchObject({
      category: "execute",
      memoryKey: "Bash:git status",
      memoryScope: "command",
    });
    expect(describeClaudeTool("Bash", { command: "git status; id" }, "/w").memoryKey).toBeNull();
    expect(describeClaudeTool("Edit", { file_path: "/x" }, "/w").category).toBe("edit");
    expect(describeClaudeTool("WebFetch", { url: "https://x.test/a" }, "/w")).toMatchObject({
      category: "fetch",
      memoryKey: "WebFetch:x.test",
      memoryScope: "host",
    });
    // One approval covers one file, whichever tool edits it.
    expect(describeClaudeTool("Edit", { file_path: "a.ts" }, "/w")).toMatchObject({
      memoryKey: "file:/w/a.ts",
      memoryScope: "file",
    });
    expect(describeClaudeTool("Write", { file_path: "/w/a.ts" }, "/w").memoryKey).toBe("file:/w/a.ts");
    expect(describeClaudeTool("Write", { file_path: "b.ts" }, "/w").memoryKey).toBe("file:/w/b.ts");
    expect(describeClaudeTool("Write", {}, "/w").memoryKey).toBeNull();
    expect(describeClaudeTool("WebFetch", { url: "https://x" }, "/w").category).toBe("fetch");
    expect(describeClaudeTool("mcp__plane__workitem", { action: "list" }, "/w")).toMatchObject({
      category: "mcp_read",
      title: "plane: workitem list",
    });
    expect(describeClaudeTool("mcp__plane__workitem", { action: "delete" }, "/w").category).toBe("mcp_write");
  });

  it("scopes Gemini's shell and edit approvals", () => {
    const shell = { toolCallId: "run_shell_command__1", kind: "execute" };
    expect(describeGeminiToolCall({ ...shell, title: "git status" }, [], "/w")).toMatchObject({
      memoryKey: "gemini:run_shell_command:git status",
      memoryScope: "command",
    });
    expect(describeGeminiToolCall({ ...shell, title: "git status | sh" }, [], "/w").memoryKey).toBeNull();
    // The title has no directory in it, so a command aimed at another one cannot be remembered.
    const elsewhere = [{ type: "content", content: { type: "text", text: "[in /tmp] (list it)" } }];
    expect(describeGeminiToolCall({ ...shell, title: "ls", content: elsewhere }, [], "/w").memoryKey).toBeNull();

    const edit = { toolCallId: "replace__1", title: "a.ts: x => y", kind: "edit" };
    expect(describeGeminiToolCall({ ...edit, locations: [{ path: "/w/a.ts" }] }, [], "/w")).toMatchObject({
      memoryKey: "file:/w/a.ts",
      memoryScope: "file",
    });
    expect(describeGeminiToolCall({ ...edit, locations: [] }, [], "/w").memoryKey).toBeNull();
  });
});

describe("what 'always allow' covers", () => {
  const key = (command: string) => shellCommandMemory("t", command).memoryKey;

  it("says when an answer covers only a path, a host or one exact request", () => {
    const always = (scope: "path" | "host" | "request") => permissionOptions(scope)[1];
    expect(always("path")).toMatchObject({
      optionId: "allow_always",
      name: "Always allow reading this path in this chat",
      _meta: { "plane/memoryScope": "path" },
    });
    expect(always("host")?.name).toBe("Always allow fetching from this host in this chat");
    expect(always("request")?.name).toBe("Always allow this exact request in this chat");
  });

  it("matches the exact command after normalising the spaces between arguments", () => {
    expect(key("git status")).toBe("t:git status");
    expect(key("  git \t  status  ")).toBe("t:git status");
    expect(key("git status --short")).not.toBe(key("git status"));
    expect(key("")).toBeNull();
    expect(key("   ")).toBeNull();
  });

  it("keeps quoted and escaped text byte for byte", () => {
    expect(key('echo "a  b"')).toBe('t:echo "a  b"');
    expect(key('echo "a  b"')).not.toBe(key('echo "a b"'));
    expect(key("echo 'a  b'")).toBe("t:echo 'a  b'");
    expect(key("echo a\\  b")).toBe("t:echo a\\  b");
    expect(key("echo a\\ b")).not.toBe(key("echo a b"));
    expect(key('echo "a\\"  b"')).toBe('t:echo "a\\"  b"');
    // Only spaces and tabs separate arguments; a no-break space is part of the word.
    expect(key("git status\u00a0")).toBe("t:git status\u00a0");
    expect(key('echo "unterminated')).toBeNull();
  });

  it.each([
    "git status; id",
    "git status && id",
    "git status || id",
    "git status | sh",
    "sleep 1 & id",
    "sleep 1 &",
    "git status > out",
    "git status >> out",
    "git status 2>&1",
    "cat < in",
    "cat <<EOF",
    "diff <(a) b",
    "echo `id`",
    "echo $(id)",
    "echo $((1+1))",
    "git status\nid",
    "git status\r\nid",
    "git status \\\nid",
    "bash -c $'a\\nb'",
    // Quotes do not help: the check cannot tell what will read them.
    "git commit -m 'a; b'",
    "grep -E 'a|b' c",
    "/bin/bash -lc 'git status; id'",
    '/bin/bash -lc "git status && id"',
  ])("never remembers %j", (command) => {
    expect(key(command)).toBeNull();
  });

  it("keeps a shell-wrapped command whole", () => {
    expect(key("/bin/bash -lc 'git status'")).toBe("t:/bin/bash -lc 'git status'");
    expect(key("/bin/bash -lc 'git status'")).not.toBe(key("/bin/bash -lc 'git log'"));
  });

  it("names one file, resolved against the working directory", () => {
    expect(fileMemory("/w", ["a/../b.ts"]).memoryKey).toBe("file:/w/b.ts");
    expect(fileMemory("/w", ["/x/b.ts"]).memoryKey).toBe("file:/x/b.ts");
    expect(fileMemory("/w", []).memoryKey).toBeNull();
    expect(fileMemory("/w", [""]).memoryKey).toBeNull();
    expect(fileMemory("/w", ["a", "b"]).memoryKey).toBeNull();
  });
});

describe("PermissionGate", () => {
  function gate(mode: "ask_all" | "ask_writes" | "yolo", answers: string[]) {
    const requests: unknown[] = [];
    const client = {
      request: async (_method: string, params: unknown) => {
        requests.push(params);
        const optionId = answers.shift();
        return optionId === "cancelled"
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId } };
      },
    } as unknown as AgentContext;
    let current = mode;
    return {
      gate: new PermissionGate(client, "s1", () => current),
      requests,
      setMode: (next: typeof mode) => (current = next),
    };
  }
  const check = {
    toolCallId: "t1",
    title: "Run: ls",
    kind: "execute" as const,
    category: "execute" as const,
    memoryKey: "Bash:ls",
  };
  const signal = new AbortController().signal;

  it("asks with allow once / always / deny and honours the answer", async () => {
    const { gate: g, requests } = gate("ask_writes", ["allow_once", "reject_once"]);
    expect(await g.check(check, signal)).toBe("allowed");
    expect(await g.check(check, signal)).toBe("rejected");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      sessionId: "s1",
      toolCall: { toolCallId: "t1", status: "pending", kind: "execute" },
      options: [
        { optionId: "allow_once", kind: "allow_once" },
        { optionId: "allow_always", kind: "allow_always", _meta: { "plane/memoryScope": "tool" } },
        { optionId: "reject_once", kind: "reject_once" },
      ],
    });
  });

  it("says what an 'always' answer covers", async () => {
    const { gate: g, requests } = gate("ask_all", ["allow_once", "allow_once", "allow_once"]);
    await g.check({ ...check, memoryKey: "Bash:ls", memoryScope: "command" }, signal);
    await g.check({ ...check, memoryKey: "file:/w/a", memoryScope: "file" }, signal);
    await g.check({ ...check, memoryKey: "Grep" }, signal);
    const names = requests.map((request) => (request as any).options[1].name);
    expect(names).toEqual([
      "Always allow this exact command in this chat",
      "Always allow edits to this file in this chat",
      "Always allow this tool in this chat",
    ]);
  });

  it("does not offer 'always' for a call it cannot remember, and ignores it if answered anyway", async () => {
    const { gate: g, requests } = gate("ask_all", ["allow_always", "allow_once"]);
    expect(await g.check({ ...check, memoryKey: null }, signal)).toBe("allowed");
    expect((requests[0] as any).options.map((option: any) => option.optionId)).toEqual(["allow_once", "reject_once"]);
    expect(await g.check({ ...check, memoryKey: null }, signal)).toBe("allowed");
    expect(requests).toHaveLength(2);
  });

  it("remembers allow_always for the session, per memory key", async () => {
    const { gate: g, requests } = gate("ask_all", ["allow_always", "allow_once"]);
    expect(await g.check(check, signal)).toBe("allowed");
    expect(await g.check(check, signal)).toBe("allowed");
    expect(requests).toHaveLength(1);
    expect(await g.check({ ...check, memoryKey: "Bash:rm" }, signal)).toBe("allowed");
    expect(requests).toHaveLength(2);
  });

  it("reads the mode live and reports a cancelled prompt", async () => {
    const { gate: g, requests, setMode } = gate("ask_writes", ["cancelled"]);
    setMode("yolo");
    expect(await g.check(check, signal)).toBe("allowed");
    expect(requests).toHaveLength(0);
    setMode("ask_writes");
    expect(await g.check(check, signal)).toBe("cancelled");
    const aborted = new AbortController();
    aborted.abort();
    expect(await g.check(check, aborted.signal)).toBe("cancelled");
  });
});
