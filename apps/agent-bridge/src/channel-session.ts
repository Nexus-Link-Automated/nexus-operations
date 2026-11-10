/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  PROTOCOL_VERSION,
  client,
  type AnyMessage,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { INITIAL_MODE_META_KEY, type PermissionLevel } from "@plane/agent-runner-protocol";

import type { Logger } from "./logger.ts";
import type { SessionPolicy } from "./policy.ts";
import { PolicyProxy } from "./proxy.ts";
import type { AgentChannel } from "./transport.ts";

/** Why a channel session gave no answer, as the API's agent-replies endpoint names it. */
export type ChannelSessionError = "timeout" | "unavailable" | "busy" | "credentials" | "failed";

export type ChannelSessionOutcome =
  | {
      readonly status: "ok";
      readonly text: string;
      /** Titles of the tool calls whose permission prompts were refused. */
      readonly permissionRequests: readonly string[];
      readonly stopReason: string;
    }
  | { readonly status: "failed"; readonly error: ChannelSessionError };

/** The most of the agent's answer kept; the API cuts it much shorter before posting it. */
export const MAX_REPLY_CHARS = 100_000;
const MAX_PERMISSION_REQUESTS = 50;
/** ACP's "authentication required": the agent has no working provider credentials. */
const AUTH_REQUIRED = -32_000;

export interface DriveChannelSessionOptions {
  /** The agent, already open on the runner. Closed when the session ends. */
  readonly upstream: AgentChannel;
  /** The same policy a browser session gets: cwd, Plane MCP, and modes clamped to the maximum. */
  readonly policy: SessionPolicy;
  readonly level: PermissionLevel;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly expiresAt?: Date | undefined;
  /** Aborted when the bridge shuts down. */
  readonly signal?: AbortSignal | undefined;
  readonly log: Logger;
  readonly clientVersion: string;
}

/**
 * One headless ACP turn for a mention in Nexus Messages: `initialize`, `session/new` at the channel's
 * level, one `session/prompt`, and the agent's message chunks collected as the answer.
 *
 * The bridge itself is the ACP client here, behind the same `PolicyProxy` a browser connection
 * gets, so every rewrite and refusal applies unchanged. Nobody can answer a permission prompt from
 * a channel, so each one is refused (its reject option, or `cancelled` if it has none) and its
 * title reported.
 */
export async function driveChannelSession(options: DriveChannelSessionOptions): Promise<ChannelSessionOutcome> {
  const { log } = options;
  const toProxy = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  let closedByProxy: { code: number; reason: string } | undefined;
  const proxy = new PolicyProxy({
    policy: options.policy,
    upstream: options.upstream,
    log,
    idleTimeoutMs: options.idleTimeoutMs,
    expiresAt: options.expiresAt,
    closeClient: (code, reason) => {
      closedByProxy ??= { code, reason };
    },
  });
  proxy.connect({ readable: toProxy.readable, writable: toClient.writable });

  let text = "";
  let afterTool = false;
  const permissionRequests: string[] = [];
  const app = client({ name: "plane-messages" })
    .onRequest("session/request_permission", ({ params }) => refuse(params, permissionRequests, log))
    .onNotification("session/update", ({ params }) => {
      const update = (params as SessionNotification).update as Record<string, unknown>;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        afterTool = text.length > 0;
        return;
      }
      if (update.sessionUpdate !== "agent_message_chunk") return;
      const content = update.content as { type?: unknown; text?: unknown } | undefined;
      if (content?.type !== "text" || typeof content.text !== "string") return;
      // Separate what the agent said before a tool call from what it said after.
      const chunk = afterTool && content.text.trim() ? `\n\n${content.text}` : content.text;
      if (content.text.trim()) afterTool = false;
      text = (text + chunk).slice(0, MAX_REPLY_CHARS);
    });
  const connection = app.connect({ readable: toClient.readable, writable: toProxy.writable });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  const aborted = new Promise<"aborted">((resolve) => {
    if (options.signal?.aborted) resolve("aborted");
    options.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const agentGone = proxy.closed.then(() => "gone" as const);

  const turn = (async () => {
    await connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // The proxy forces these anyway. Notices keep its Plane-MCP warning out of the answer.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        session: { notices: {} },
      },
      clientInfo: { name: "plane-messages", version: options.clientVersion },
    } as never);
    const session = (await connection.agent.request("session/new", {
      cwd: "/",
      mcpServers: [],
      _meta: { [INITIAL_MODE_META_KEY]: options.level },
    } as never)) as { sessionId: string };
    const result = (await connection.agent.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: options.prompt }],
    } as never)) as { stopReason: string };
    return result.stopReason;
  })();
  turn.catch(() => undefined);

  try {
    const first = await Promise.race([turn, timedOut, aborted, agentGone]);
    if (first === "timeout") return { status: "failed", error: "timeout" };
    if (first === "aborted") return { status: "failed", error: "unavailable" };
    if (first === "gone") {
      log.warn("agent-bridge: the agent went away during a channel session", { reason: closedByProxy?.reason });
      return { status: "failed", error: "failed" };
    }
    return { status: "ok", text, permissionRequests, stopReason: first };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = (error as Error)?.message ?? String(error);
    log.warn("agent-bridge: channel session failed", { code, error: message.slice(0, 300) });
    if (code === AUTH_REQUIRED || /\b(api key|credential|unauthori[sz]ed|authenticat)/i.test(message)) {
      return { status: "failed", error: "credentials" };
    }
    return { status: "failed", error: "failed" };
  } finally {
    clearTimeout(timer);
    connection.close();
    proxy.close("channel session finished");
  }
}

function refuse(params: RequestPermissionRequest, titles: string[], log: Logger): RequestPermissionResponse {
  const title = typeof params.toolCall?.title === "string" ? params.toolCall.title.trim() : "";
  if (titles.length < MAX_PERMISSION_REQUESTS) titles.push(title || "use a tool");
  log.info("agent-bridge: refused a permission prompt in a channel session");
  const reject =
    params.options.find((option) => option.kind === "reject_once") ??
    params.options.find((option) => option.kind === "reject_always");
  return reject
    ? { outcome: { outcome: "selected", optionId: reject.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
