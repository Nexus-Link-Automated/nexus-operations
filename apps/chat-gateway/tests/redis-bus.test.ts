/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RedisEventBus, workspaceChannel } from "../src/bus.ts";
import { silentLogger } from "../src/logger.ts";
import { REDIS_URL, killSubscriber, redisAvailable } from "./helpers/redis.ts";
import { settle, waitUntil } from "./helpers/ws-client.ts";

// Per-file names, so test files running in parallel against one Redis never hear each other.
const W1 = `w1-${randomUUID()}`;
const W2 = `w2-${randomUUID()}`;

describe.skipIf(!redisAvailable)("RedisEventBus", () => {
  let bus: RedisEventBus;
  let name: string;
  let publisher: Redis;
  let received: [string, string][];
  let gaps: number;

  beforeEach(async () => {
    received = [];
    gaps = 0;
    publisher = new Redis(REDIS_URL);
    name = `chat-gateway-test-${randomUUID()}`;
    bus = new RedisEventBus({ url: REDIS_URL, log: silentLogger, connectionName: name });
    bus.onMessage((workspaceId, raw) => received.push([workspaceId, raw]));
    bus.onGap(() => {
      gaps += 1;
    });
    await waitUntil(() => bus.connected);
  });

  afterEach(async () => {
    publisher.disconnect();
    await bus.close();
  });

  it("uses the channel Django publishes to", () => {
    expect(workspaceChannel("w1")).toBe("chat:workspace:w1");
  });

  it("delivers a subscribed workspace's messages, and only those", async () => {
    await bus.subscribe(W1);
    await publisher.publish(workspaceChannel(W1), "one");
    await publisher.publish(workspaceChannel(W2), "not subscribed");
    await publisher.publish("chat:something:else", "not ours");
    await publisher.publish(workspaceChannel(W1), "two");
    await waitUntil(() => received.length === 2);
    await settle(50);
    expect(received).toEqual([
      [W1, "one"],
      [W1, "two"],
    ]);
  });

  it("stops delivering once a workspace is unsubscribed", async () => {
    await bus.subscribe(W1);
    await bus.unsubscribe(W1);
    await publisher.publish(workspaceChannel(W1), "late");
    await settle(100);
    expect(received).toEqual([]);
  });

  it("announces a gap only once it is listening to the same workspaces again", async () => {
    await bus.subscribe(W1);
    await bus.subscribe(W2);
    await killSubscriber(name);
    await waitUntil(() => gaps === 1);
    expect(gaps).toBe(1);
    await publisher.publish(workspaceChannel(W1), "after one");
    await publisher.publish(workspaceChannel(W2), "after two");
    await waitUntil(() => received.length === 2);
    expect(received.map(([workspaceId]) => workspaceId).toSorted()).toEqual([W1, W2]);
  });

  it("can be closed twice", async () => {
    await bus.close();
    await bus.close();
    expect(bus.connected).toBe(false);
  });
});
