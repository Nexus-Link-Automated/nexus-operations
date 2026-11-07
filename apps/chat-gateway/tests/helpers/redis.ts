/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

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
