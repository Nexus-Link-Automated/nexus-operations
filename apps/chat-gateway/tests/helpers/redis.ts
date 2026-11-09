/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { connect, createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { Redis } from "ioredis";

/** A Redis (or Valkey) to run the real-bus tests against; they are skipped when there is none. */
export const REDIS_URL = process.env.CHAT_GATEWAY_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";

async function probe(url: string): Promise<boolean> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export const redisAvailable = await probe(REDIS_URL);

/** Drop the subscriber connection named `connectionName` (and only that one) from the server's side. */
export async function killSubscriber(connectionName: string): Promise<void> {
  const admin = new Redis(REDIS_URL);
  try {
    const list = String(await admin.call("CLIENT", "LIST", "TYPE", "pubsub"));
    const line = list.split("\n").find((entry) => entry.split(" ").includes(`name=${connectionName}`));
    const id = line
      ?.split(" ")
      .find((field) => field.startsWith("id="))
      ?.slice(3);
    if (!id) throw new Error(`no subscriber connection named ${connectionName}`);
    await admin.call("CLIENT", "KILL", "ID", id);
  } finally {
    admin.disconnect();
  }
}

/** A TCP proxy in front of the test Redis, for the failures Redis itself can't be made to have. */
export interface RedisProxy {
  readonly url: string;
  /** Keep today's connections open but silently carry nothing more on them, as a dead network path does. */
  blackhole(): void;
  /** Hold back everything sent towards Redis by this many ms. */
  delayToRedis: number;
  close(): Promise<void>;
}

export async function startRedisProxy(): Promise<RedisProxy> {
  const target = new URL(REDIS_URL);
  const pairs = new Set<{ client: Socket; upstream: Socket; silenced: boolean }>();
  const proxy = { delayToRedis: 0 };
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 6379), target.hostname);
    const pair = { client, upstream, silenced: false };
    pairs.add(pair);
    client.on("data", (chunk) => {
      if (pair.silenced) return;
      const forward = () => {
        if (!upstream.destroyed) upstream.write(chunk);
      };
      if (proxy.delayToRedis > 0) setTimeout(forward, proxy.delayToRedis);
      else forward();
    });
    upstream.on("data", (chunk) => {
      if (!pair.silenced && !client.destroyed) client.write(chunk);
    });
    const end = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", end);
      socket.on("close", end);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(proxy, {
    url: `redis://127.0.0.1:${port}`,
    blackhole() {
      for (const pair of pairs) pair.silenced = true;
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
