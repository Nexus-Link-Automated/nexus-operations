/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatEvent, eventsOf, startHarness, type Harness } from "./helpers/harness.ts";
import { redisAvailable } from "./helpers/redis.ts";
import { ADA, BEN, CARA, WORKSPACE_ID } from "./helpers/stub-api.ts";
import { waitUntil } from "./helpers/ws-client.ts";

// The same behaviour over the in-process bus and over real Redis (when there is one to test against).
for (const kind of ["memory", "redis"] as const) {
  describe.skipIf(kind === "redis" && !redisAvailable)(`fan-out over ${kind}`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await startHarness({ bus: kind });
    });
    afterEach(async () => {
      await h.stop();
    });

    it("tells a client which channels it is in", async () => {
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const standup = h.api.addChannel({ kind: "private", members: [ADA.id] });
      const archived = h.api.addChannel({ members: [ADA.id], archived: true });
      h.api.addChannel({ members: [BEN.id] }); // public, but Ada hasn't joined
      h.api.addChannel({ kind: "private", members: [BEN.id] }); // Ada can't even see it
      const ada = await h.open();
      const ready = ada.of("ready")[0]!;
      expect((ready.channels as string[]).toSorted()).toEqual([general, standup, archived].toSorted());
    });

    it("lets two clients see each other's messages instantly", async () => {
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);

      const first = chatEvent("message.created", { channel_id: general, message_id: randomUUID(), actor_id: ADA.id });
      const sentAt = performance.now();
      await h.publish(first);
      const seen = await Promise.all(
        [ada, ben].map((client) =>
          client.waitFor((f) => (f.event as { message_id?: string })?.message_id === first.message_id)
        )
      );
      expect(seen).toEqual([
        { type: "event", event: first },
        { type: "event", event: first },
      ]);
      expect(performance.now() - sentAt).toBeLessThan(1000);

      const reply = chatEvent("message.created", { channel_id: general, message_id: randomUUID(), actor_id: BEN.id });
      await h.publish(reply);
      await Promise.all(
        [ada, ben].map((client) =>
          client.waitFor((f) => (f.event as { message_id?: string })?.message_id === reply.message_id)
        )
      );
      for (const client of [ada, ben]) {
        expect(eventsOf(client).map((e) => e.message_id)).toEqual([first.message_id, reply.message_id]);
      }
    });

    it("sends a non-member nothing", async () => {
      const general = h.api.addChannel({ members: [ADA.id, BEN.id, CARA.id] });
      const team = h.api.addChannel({ kind: "private", members: [ADA.id, BEN.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);
      const cara = await h.open(CARA.cookie);

      await h.publish(chatEvent("message.created", { channel_id: team, message_id: randomUUID(), actor_id: ADA.id }));
      await h.publish(chatEvent("message.updated", { channel_id: team, message_id: randomUUID(), actor_id: ADA.id }));
      await h.publish(chatEvent("message.removed", { channel_id: team, message_id: randomUUID(), actor_id: ADA.id }));
      await h.publish(chatEvent("channel.updated", { channel_id: team, actor_id: ADA.id }));
      await h.publish(chatEvent("member.added", { channel_id: team, user_id: BEN.id, actor_id: ADA.id }));
      await h.barrier(general, ada, ben, cara);

      expect(eventsOf(ada)).toHaveLength(5);
      expect(eventsOf(ben)).toHaveLength(5);
      expect(eventsOf(cara)).toEqual([]);
    });

    it("sends nothing for a public channel the user hasn't joined or asked for", async () => {
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const lounge = h.api.addChannel({ members: [BEN.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);
      await h.publish(chatEvent("message.created", { channel_id: lounge, message_id: randomUUID() }));
      await h.barrier(general, ada, ben);
      expect(eventsOf(ben)).toHaveLength(1);
      expect(eventsOf(ada)).toEqual([]);
    });

    it("sends read positions only to the reader's own sockets", async () => {
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const adaTab1 = await h.open(ADA.cookie);
      const adaTab2 = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);
      const read = chatEvent("read.updated", { channel_id: general, message_id: randomUUID(), user_id: ADA.id });
      await h.publish(read);
      await h.barrier(general, adaTab1, adaTab2, ben);
      expect(eventsOf(adaTab1)).toEqual([read]);
      expect(eventsOf(adaTab2)).toEqual([read]);
      expect(eventsOf(ben)).toEqual([]);
    });

    it("introduces a new DM to its two people and nobody else", async () => {
      const general = h.api.addChannel({ members: [ADA.id, BEN.id, CARA.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);
      const cara = await h.open(CARA.cookie);

      const dm = h.api.addChannel({ kind: "dm", members: [ADA.id, BEN.id] });
      await h.publish(chatEvent("member.added", { channel_id: dm, user_id: ADA.id, actor_id: ADA.id }));
      await h.publish(chatEvent("member.added", { channel_id: dm, user_id: BEN.id, actor_id: ADA.id }));
      await h.publish(chatEvent("channel.created", { channel_id: dm, actor_id: ADA.id }));
      const hello = chatEvent("message.created", { channel_id: dm, message_id: randomUUID(), actor_id: ADA.id });
      await h.publish(hello);
      await h.barrier(general, ada, ben, cara);

      // Each hears about the DM from their own `member.added`; what was published before it was not theirs yet.
      expect(eventsOf(ada).map((e) => `${e.type} ${e.user_id ?? ""}`.trim())).toEqual([
        `member.added ${ADA.id}`,
        `member.added ${BEN.id}`,
        "channel.created",
        "message.created",
      ]);
      expect(eventsOf(ben).map((e) => `${e.type} ${e.user_id ?? ""}`.trim())).toEqual([
        `member.added ${BEN.id}`,
        "channel.created",
        "message.created",
      ]);
      expect(eventsOf(cara)).toEqual([]);
    });

    it("starts sending a channel's events once the user is added to it", async () => {
      const general = h.api.addChannel({ members: [ADA.id] });
      const secret = h.api.addChannel({ kind: "private", members: [BEN.id] });
      const ada = await h.open(ADA.cookie);
      await h.publish(chatEvent("message.created", { channel_id: secret, message_id: randomUUID() }));
      await h.barrier(general, ada);
      expect(eventsOf(ada)).toEqual([]);

      await h.publish(chatEvent("member.added", { channel_id: secret, user_id: ADA.id, actor_id: BEN.id }));
      const later = chatEvent("message.created", { channel_id: secret, message_id: randomUUID() });
      await h.publish(later);
      await ada.waitFor((f) => (f.event as { message_id?: string })?.message_id === later.message_id);
      expect(eventsOf(ada).map((e) => e.type)).toEqual(["member.added", "message.created"]);
    });

    it("stops a removed member's events at once, after telling them", async () => {
      const team = h.api.addChannel({ kind: "private", members: [ADA.id, BEN.id] });
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);

      const removed = chatEvent("member.removed", { channel_id: team, user_id: BEN.id, actor_id: ADA.id });
      await h.publish(removed);
      await h.publish(chatEvent("message.created", { channel_id: team, message_id: randomUUID(), actor_id: ADA.id }));
      await h.barrier(general, ada, ben);

      expect(eventsOf(ben)).toEqual([removed]);
      expect(eventsOf(ada).map((e) => e.type)).toEqual(["member.removed", "message.created"]);
    });

    it("keeps sending to the others when someone else leaves", async () => {
      const team = h.api.addChannel({ kind: "private", members: [ADA.id, BEN.id] });
      const ada = await h.open(ADA.cookie);
      await h.publish(chatEvent("member.removed", { channel_id: team, user_id: BEN.id }));
      const later = chatEvent("message.created", { channel_id: team, message_id: randomUUID() });
      await h.publish(later);
      await ada.waitFor((f) => (f.event as { message_id?: string })?.message_id === later.message_id);
      expect(eventsOf(ada).map((e) => e.type)).toEqual(["member.removed", "message.created"]);
    });

    it("tells a channel's members an agent joined or left it, and changes nobody's feed", async () => {
      const team = h.api.addChannel({ kind: "private", members: [ADA.id] });
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);
      const agentId = randomUUID();

      const added = chatEvent("member.added", { channel_id: team, agent_id: agentId, actor_id: ADA.id });
      const removed = chatEvent("member.removed", { channel_id: team, agent_id: agentId, actor_id: ADA.id });
      await h.publish(added);
      await h.publish(removed);
      const later = chatEvent("message.created", { channel_id: team, message_id: randomUUID() });
      await h.publish(later);
      await h.barrier(general, ada, ben);

      // Ada is still in the channel after the agent left it; Ben was never told about it.
      expect(eventsOf(ada)).toEqual([added, removed, later]);
      expect(eventsOf(ben)).toEqual([]);
    });

    it("tells a private channel's members, and only them, that an agent is responding", async () => {
      const team = h.api.addChannel({ kind: "private", members: [ADA.id] });
      const general = h.api.addChannel({ members: [ADA.id, BEN.id] });
      const ada = await h.open(ADA.cookie);
      const ben = await h.open(BEN.cookie);
      const ids = { channel_id: team, message_id: randomUUID(), agent_id: randomUUID() };
      const responding = chatEvent("agent.responding", { ...ids, parent_id: ids.message_id });
      const responded = chatEvent("agent.responded", { ...ids, parent_id: ids.message_id });
      await h.publish(responding);
      await h.publish(responded);
      await h.barrier(general, ada, ben);
      expect(eventsOf(ada)).toEqual([responding, responded]);
      expect(eventsOf(ben)).toEqual([]);
    });

    it("keeps an archived channel in the feed, so unarchiving it reaches its members", async () => {
      const dormant = h.api.addChannel({ members: [ADA.id], archived: true });
      const ada = await h.open(ADA.cookie);
      const unarchived = chatEvent("channel.unarchived", { channel_id: dormant, actor_id: BEN.id });
      await h.publish(unarchived);
      await ada.waitFor((f) => f.type === "event");
      expect(eventsOf(ada)).toEqual([unarchived]);
    });

    it("keeps events in the order they were published", async () => {
      const general = h.api.addChannel({ members: [ADA.id] });
      const ada = await h.open(ADA.cookie);
      const ids = Array.from({ length: 40 }, () => randomUUID());
      for (const id of ids) {
        // oxlint-disable-next-line no-await-in-loop -- the order is the point
        await h.publish(chatEvent("message.created", { channel_id: general, message_id: id }));
      }
      await waitUntil(() => eventsOf(ada).length === ids.length);
      expect(eventsOf(ada).map((e) => e.message_id)).toEqual(ids);
    });

    it("sends only the fields of an event it knows", async () => {
      const general = h.api.addChannel({ members: [ADA.id] });
      const ada = await h.open(ADA.cookie);
      const messageId = randomUUID();
      await h.publish(
        JSON.stringify({
          ...chatEvent("message.created", { channel_id: general, message_id: messageId }),
          body_html: "<p>should never be here</p>",
          sender_email: "x@example.com",
        })
      );
      await ada.waitFor((f) => f.type === "event");
      const sent = eventsOf(ada)[0]!;
      expect(sent.message_id).toBe(messageId);
      expect(JSON.stringify(sent)).not.toContain("should never be here");
      expect(Object.keys(sent).toSorted()).toEqual(["at", "channel_id", "message_id", "type", "workspace_id"]);
    });

    it("ignores an event far too large to be one", async () => {
      const general = h.api.addChannel({ members: [ADA.id] });
      const ada = await h.open(ADA.cookie);
      await h.publish(chatEvent("message.created", { channel_id: general, message_id: "x".repeat(64 * 1024) }));
      const real = chatEvent("message.created", { channel_id: general, message_id: randomUUID() });
      await h.publish(real);
      await ada.waitFor((f) => f.type === "event");
      expect(eventsOf(ada)).toEqual([real]);
    });

    it("ignores events it can't use, and carries on", async () => {
      const general = h.api.addChannel({ members: [ADA.id] });
      const ada = await h.open(ADA.cookie);
      await h.publish("not json");
      await h.publish("{}");
      await h.publish(JSON.stringify({ type: "message.shouted", workspace_id: WORKSPACE_ID, at: "now" }));
      // Published to this workspace's channel, but for another workspace.
      await h.publish(chatEvent("message.created", { channel_id: general, workspace_id: randomUUID() }));
      const real = chatEvent("message.created", { channel_id: general, message_id: randomUUID() });
      await h.publish(real);
      await ada.waitFor((f) => f.type === "event");
      expect(eventsOf(ada)).toEqual([real]);
      expect(ada.closeCode).toBeUndefined();
    });
  });
}

describe("the bus subscription", () => {
  let h: Harness;
  afterEach(async () => {
    await h.stop();
  });

  it("is made once per workspace and let go when its last socket leaves", async () => {
    h = await startHarness();
    const one = await h.open(ADA.cookie);
    const two = await h.open(BEN.cookie);
    expect(h.memory!.calls).toEqual([`subscribe ${WORKSPACE_ID}`]);
    expect(h.gateway.connectionCount).toBe(2);

    one.socket.close();
    await waitUntil(() => h.gateway.connectionCount === 1);
    expect(h.memory!.subscribed.has(WORKSPACE_ID)).toBe(true);

    two.socket.close();
    await waitUntil(() => !h.memory!.subscribed.has(WORKSPACE_ID));
    expect(h.memory!.calls).toEqual([`subscribe ${WORKSPACE_ID}`, `unsubscribe ${WORKSPACE_ID}`]);
  });
});
