/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { AnyMessage } from "@agentclientprotocol/sdk";

import type { AgentChannel, AgentTransport } from "../../src/transport.ts";
import type { AgentSessionGrant } from "../../src/plane-api.ts";

type Message = Record<string, unknown> & {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/**
 * What a scripted agent does with `session/prompt`: send updates and requests through `agent`, then
 * return the prompt's result, or throw `{code, message}` to answer with an error.
 */
export type PromptScript = (agent: FakeAgent, prompt: Message) => Promise<unknown>;

const MODES = ["ask_all", "ask_writes", "yolo"].map((id) => ({ id, name: id }));

/** A scripted ACP agent behind an in-memory channel. Answers the usual requests and records everything. */
export class FakeAgent {
  readonly received: Message[] = [];
  closed = false;
  readonly #writer: WritableStreamDefaultWriter<AnyMessage>;
  readonly channel: AgentChannel;
  readonly grant: AgentSessionGrant;
  readonly options: { http: boolean };
  script: PromptScript | undefined;
  #nextId = 0;

  constructor(grant: AgentSessionGrant, options: { http: boolean }, script?: PromptScript) {
    this.script = script;
    this.grant = grant;
    this.options = options;
    const toAgent = new TransformStream<AnyMessage, AnyMessage>();
    const toBridge = new TransformStream<AnyMessage, AnyMessage>();
    this.#writer = toBridge.writable.getWriter();
    this.channel = {
      stream: { readable: toBridge.readable, writable: toAgent.writable },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        this.#writer.close().catch(() => undefined);
      },
    };
    void this.#serve(toAgent.readable.getReader());
  }

  async send(message: Record<string, unknown>): Promise<void> {
    await this.#writer.write({ jsonrpc: "2.0", ...message } as AnyMessage);
  }

  /** A `session/update` for the current session. */
  async update(update: Record<string, unknown>): Promise<void> {
    await this.send({ method: "session/update", params: { sessionId: "fake-session-1", update } });
  }

  /** Send a request to the client and wait for its answer. */
  async request(method: string, params: Record<string, unknown>): Promise<Message> {
    const id = `agent-${(this.#nextId += 1)}`;
    await this.send({ id, method, params });
    for (;;) {
      const answer = this.received.find((m) => m.id === id && m.method === undefined);
      if (answer) return answer;
      if (this.closed) throw new Error("closed");
      // oxlint-disable-next-line no-await-in-loop -- polling
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async #serve(reader: ReadableStreamDefaultReader<AnyMessage>): Promise<void> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || !value) return;
      const message = value as unknown as Message;
      this.received.push(message);
      if (typeof message.method !== "string" || message.id === undefined) continue;
      if (message.method === "session/prompt" && this.script) {
        // Not awaited: the script may wait for answers, which arrive through this same loop.
        void this.#runScript(this.script, message);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- in order
      await this.send({ id: message.id, result: this.#answer(message) }).catch(() => undefined);
    }
  }

  async #runScript(script: PromptScript, message: Message): Promise<void> {
    try {
      const result = await script(this, message);
      await this.send({ id: message.id, result });
    } catch (error) {
      const { code = -32603, message: text = "failed" } = error as { code?: number; message?: string };
      await this.send({ id: message.id, error: { code, message: text } }).catch(() => undefined);
    }
  }

  #answer(message: Message): unknown {
    const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: this.options.http, sse: false } },
          authMethods: [],
        };
      case "session/new":
      case "session/load":
      case "session/resume":
        return {
          ...(message.method === "session/new" ? { sessionId: "fake-session-1" } : {}),
          modes: { currentModeId: meta["plane/initialModeId"], availableModes: MODES },
        };
      case "session/prompt":
        return { stopReason: "end_turn" };
      default:
        return {};
    }
  }
}

/** An AgentTransport whose agents are FakeAgents. */
export class FakeTransport implements AgentTransport {
  readonly agents: FakeAgent[] = [];
  fail = false;
  /** Given to every agent opened from now on. */
  script: PromptScript | undefined;
  readonly options: { http: boolean };

  constructor(options: { http: boolean } = { http: true }) {
    this.options = options;
  }

  async open(grant: AgentSessionGrant): Promise<AgentChannel> {
    if (this.fail) throw new Error("runner down");
    const agent = new FakeAgent(grant, this.options, this.script);
    this.agents.push(agent);
    return agent.channel;
  }
}
