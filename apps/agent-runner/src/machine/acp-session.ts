/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Readable, Writable } from "node:stream";

import {
  client,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

/**
 * One coding job's conversation with its agent over ACP: initialize, a session in the job's
 * repository in `yolo` mode (the job runs alone in its container, with nobody to approve each
 * step), the CRM's instructions as the first prompt, and `session/cancel` when the job is stopped.
 * When a turn ends, `nextPrompt` may give the agent another one in the same session (the answer to
 * a question it asked the CRM).
 */

/** `session/new` `_meta` key the adapters read the starting permission mode from. */
export const INITIAL_MODE_META_KEY = "plane/initialModeId";
export const JOB_MODE = "yolo";
/** Inbound ACP frame limit, as the adapters use. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface AgentSessionOptions {
  /** The agent's stdin and stdout. */
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  /** The repository, as the agent sees it (inside the container). */
  readonly cwd: string;
  readonly prompt: string;
  /** Aborted to stop the job: the agent gets `session/cancel`. */
  readonly signal: AbortSignal;
  readonly onUpdate: (update: SessionNotification["update"]) => void;
  /** After each turn: the next prompt in the same session, or undefined to end. */
  readonly nextPrompt?: (stopReason: string) => Promise<string | undefined>;
}

export interface AgentSessionResult {
  readonly stopReason: string;
}

/**
 * Nobody can answer a prompt during a job, and the session is in `yolo`, so the adapters should
 * not ask; if one does, the first "allow" option is chosen (the container is the boundary).
 */
export function choosePermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const option =
    request.options.find((candidate) => candidate.kind === "allow_once") ??
    request.options.find((candidate) => candidate.kind === "allow_always");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export async function runAgentSession(options: AgentSessionOptions): Promise<AgentSessionResult> {
  const stream = ndJsonStream(
    Writable.toWeb(options.stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(options.stdout as Readable) as ReadableStream<Uint8Array>,
    { maxMessageBytes: MAX_MESSAGE_BYTES }
  );
  const app = client({ name: "nexus-machine" })
    .onNotification("session/update", ({ params }) => {
      options.onUpdate(params.update);
    })
    .onRequest("session/request_permission", async ({ params }) => choosePermission(params));
  const connection = app.connect(stream);
  const { agent } = connection;
  let sessionId: string | undefined;
  const cancel = () => {
    if (sessionId) void agent.notify("session/cancel", { sessionId }).catch(() => undefined);
  };
  try {
    if (options.signal.aborted) return { stopReason: "cancelled" };
    await agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = await agent.request("session/new", {
      cwd: options.cwd,
      mcpServers: [],
      _meta: { [INITIAL_MODE_META_KEY]: JOB_MODE },
    });
    sessionId = session.sessionId;
    if (options.signal.aborted) return { stopReason: "cancelled" };
    options.signal.addEventListener("abort", cancel, { once: true });
    let prompt = options.prompt;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one turn after the other, in the same session
      const answer = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      if (options.signal.aborted || answer.stopReason === "cancelled" || !options.nextPrompt) {
        return { stopReason: answer.stopReason };
      }
      // oxlint-disable-next-line no-await-in-loop -- waits for the answer to the agent's question
      const next = await options.nextPrompt(answer.stopReason);
      if (!next || options.signal.aborted) return { stopReason: answer.stopReason };
      prompt = next;
    }
  } finally {
    options.signal.removeEventListener("abort", cancel);
    connection.close();
  }
}
