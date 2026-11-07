/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Redis } from "ioredis";

import type { Logger } from "./logger.ts";

const CHANNEL_PREFIX = "chat:workspace:";

/** The Redis pub/sub channel Django publishes a workspace's chat events on. */
export function workspaceChannel(workspaceId: string): string {
  return `${CHANNEL_PREFIX}${workspaceId}`;
}

/**
 * Where chat events come from. Redis pub/sub keeps nothing and delivers to whoever is listening at that
 * moment, so a bus also says when it may have missed some (`onGap`): browsers then fetch what they missed.
 */
export interface EventBus {
  /** Whether events are flowing right now. */
  readonly connected: boolean;
  /** Start receiving a workspace's events. Resolves once the subscription is active. */
  subscribe(workspaceId: string): Promise<void>;
  unsubscribe(workspaceId: string): Promise<void>;
  /** Called with the raw payload of every message on a subscribed workspace's channel. */
  onMessage(handler: (workspaceId: string, raw: string) => void): void;
  /** Called when events may have been missed: the connection dropped and has been restored and resubscribed. */
  onGap(handler: () => void): void;
  close(): Promise<void>;
}

export interface RedisEventBusOptions {
  readonly url: string;
  readonly log: Logger;
  /** Shown in Redis's `CLIENT LIST`, so the gateway's subscriber connection can be told apart. */
  readonly connectionName?: string;
}

/** An `EventBus` over a Redis subscriber connection (Redis and Valkey both work). */
export class RedisEventBus implements EventBus {
  readonly #redis: Redis;
  readonly #log: Logger;
  readonly #subscribed = new Set<string>();
  readonly #messageHandlers: ((workspaceId: string, raw: string) => void)[] = [];
  readonly #gapHandlers: (() => void)[] = [];
  #everReady = false;
  #closed = false;

  constructor(options: RedisEventBusOptions) {
    this.#log = options.log;
    // Resubscribing is done here, not by ioredis, so that the gap is announced only once events flow again.
    this.#redis = new Redis(options.url, {
      autoResubscribe: false,
      maxRetriesPerRequest: null,
      connectionName: options.connectionName ?? "chat-gateway",
    });
    this.#redis.on("error", (error: Error) => {
      this.#log.error("chat-gateway: redis error", { error: error.message });
    });
    this.#redis.on("message", (channel: string, raw: string) => {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      const workspaceId = channel.slice(CHANNEL_PREFIX.length);
      for (const handler of this.#messageHandlers) handler(workspaceId, raw);
    });
    this.#redis.on("ready", () => {
      if (!this.#everReady) {
        this.#everReady = true;
        this.#log.info("chat-gateway: redis connected");
        return;
      }
      void this.#recover();
    });
    this.#redis.on("close", () => {
      if (!this.#closed) this.#log.warn("chat-gateway: redis connection lost");
    });
  }

  get connected(): boolean {
    return !this.#closed && this.#redis.status === "ready";
  }

  async subscribe(workspaceId: string): Promise<void> {
    this.#subscribed.add(workspaceId);
    await this.#redis.subscribe(workspaceChannel(workspaceId));
  }

  async unsubscribe(workspaceId: string): Promise<void> {
    this.#subscribed.delete(workspaceId);
    await this.#redis.unsubscribe(workspaceChannel(workspaceId));
  }

  onMessage(handler: (workspaceId: string, raw: string) => void): void {
    this.#messageHandlers.push(handler);
  }

  onGap(handler: () => void): void {
    this.#gapHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#redis.quit();
    } catch {
      this.#redis.disconnect();
    }
  }

  /** The connection came back: listen again, and only then tell everyone they may have missed events. */
  async #recover(): Promise<void> {
    this.#log.info("chat-gateway: redis reconnected");
    try {
      if (this.#subscribed.size > 0) {
        await this.#redis.subscribe(...[...this.#subscribed].map(workspaceChannel));
      }
    } catch (error) {
      this.#log.error("chat-gateway: could not resubscribe to redis", { error: (error as Error).message });
      return;
    }
    for (const handler of this.#gapHandlers) handler();
  }
}
