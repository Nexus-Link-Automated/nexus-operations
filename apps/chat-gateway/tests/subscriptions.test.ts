/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { CloseCode } from "../src/protocol.ts";
import { chatEvent, eventsOf, startHarness, type Harness } from "./helpers/harness.ts";
import { ADA, BEN, WORKSPACE_SLUG } from "./helpers/stub-api.ts";
import { settle, waitUntil } from "./helpers/ws-client.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const channelRequests = (harness: Harness, channelId: string) =>
  harness.api.requestsTo(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/${channelId}/`);

describe("subscribing to a public channel the user hasn't joined", () => {
  it("follows it after the API says the user can see it, until they unsubscribe", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    const lounge = h.api.addChannel({ members: [BEN.id] });
    const ada = await h.open(ADA.cookie);

    ada.send({ type: "subscribe", channel_id: lounge });
    expect(await ada.next("subscribed")).toEqual({ type: "subscribed", channel_id: lounge });
    expect(channelRequests(h, lounge)).toHaveLength(1);
    expect(channelRequests(h, lounge)[0]!.cookie).toBe(ADA.cookie);

    const hello = chatEvent("message.created", { channel_id: lounge, message_id: randomUUID() });
    await h.publish(hello);
    await ada.waitFor((f) => f.type === "event");
    expect(eventsOf(ada)).toEqual([hello]);

    ada.send({ type: "unsubscribe", channel_id: lounge });
    expect(await ada.next("unsubscribed")).toEqual({ type: "unsubscribed", channel_id: lounge, reason: "requested" });
    await h.publish(chatEvent("message.created", { channel_id: lounge, message_id: randomUUID() }));
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toEqual([hello]);
  });

  it("answers a channel the user can't see with not_found, and doesn't ask the API twice", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id] });
    const hidden = h.api.addChannel({ kind: "private", members: [BEN.id] });
    const ada = await h.open(ADA.cookie);

    ada.send({ type: "subscribe", channel_id: hidden });
    const first = await ada.next("error");
    expect(first).toMatchObject({ code: "not_found", channel_id: hidden });
    ada.send({ type: "subscribe", channel_id: hidden });
    await ada.waitFor((f) => f.type === "error" && f !== first);
    expect(channelRequests(h, hidden)).toHaveLength(1);

    await h.publish(chatEvent("message.created", { channel_id: hidden, message_id: randomUUID() }));
    await settle();
    expect(eventsOf(ada)).toEqual([]);
  });

  it("answers a channel that doesn't exist the same way", async () => {
    h = await startHarness();
    const ada = await h.open(ADA.cookie);
    ada.send({ type: "subscribe", channel_id: randomUUID() });
    expect(await ada.next("error")).toMatchObject({ code: "not_found" });
  });

  it("doesn't ask the API about a channel the user is already in", async () => {
    h = await startHarness();
    const mine = h.api.addChannel({ kind: "private", members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    ada.send({ type: "subscribe", channel_id: mine });
    expect(await ada.next("subscribed")).toMatchObject({ channel_id: mine });
    expect(channelRequests(h, mine)).toHaveLength(0);
  });

  it("treats a channel the user has since joined as theirs, not as a subscription", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    // Ada connected before she joined, and the event is yet to arrive.
    const ada = await h.open(ADA.cookie);
    const later = h.api.addChannel({ members: [BEN.id] });
    h.api.channels.get(later)!.members.add(ADA.id);
    ada.send({ type: "subscribe", channel_id: later });
    await ada.next("subscribed");
    ada.send({ type: "unsubscribe", channel_id: later });
    // A member can't stop following a channel they're in.
    expect(await ada.next("error")).toMatchObject({ code: "bad_request", channel_id: later });
    await h.publish(chatEvent("message.created", { channel_id: later, message_id: randomUUID() }));
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toHaveLength(1);
  });

  it("accepts the channel ID in any case", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    const lounge = h.api.addChannel({ members: [BEN.id] });
    const ada = await h.open(ADA.cookie);
    ada.send({ type: "subscribe", channel_id: lounge.toUpperCase() });
    expect(await ada.next("subscribed")).toMatchObject({ channel_id: lounge });
    await h.publish(chatEvent("message.created", { channel_id: lounge, message_id: randomUUID() }));
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toHaveLength(1);
  });

  it("doesn't believe an answer that a removal overtook", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    const team = h.api.addChannel({ kind: "private", members: [ADA.id, BEN.id] });
    h.api.channels.get(team)!.members.delete(ADA.id);
    const ada = await h.open(ADA.cookie);

    // Ada joined after her socket opened; she asks for the channel and is taken out while the (older) answer travels.
    h.api.channels.get(team)!.members.add(ADA.id);
    h.api.delayPaths.set(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/${team}/`, 150);
    ada.send({ type: "subscribe", channel_id: team });
    await waitUntil(() => channelRequests(h!, team).length === 1);
    await h.publish(chatEvent("member.removed", { channel_id: team, user_id: ADA.id, actor_id: BEN.id }));
    await ada.waitFor((f) => f.channel_id === team);

    await h.publish(chatEvent("message.created", { channel_id: team, message_id: randomUUID() }));
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toEqual([]);
  });

  it("answers when it can't tell whether the user may see a channel", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id] });
    const lounge = h.api.addChannel({ members: [BEN.id] });
    const ada = await h.open(ADA.cookie);
    h.api.failPaths.set(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/${lounge}/`, 403);
    ada.send({ type: "subscribe", channel_id: lounge });
    expect(await ada.next("error")).toMatchObject({ code: "unavailable", channel_id: lounge });
    expect(ada.closeCode).toBeUndefined();
  });

  it("counts WebSocket pings towards the limit on frames", async () => {
    h = await startHarness({ config: { rateFrames: 5, rateWindowMs: 10_000 } });
    const ada = await h.open(ADA.cookie);
    for (let i = 0; i < 10; i += 1) ada.socket.ping();
    expect(await ada.closed()).toBe(CloseCode.tooManyRequests);
  });

  it("limits how many channels one socket follows beyond its own", async () => {
    h = await startHarness({ config: { maxSubscriptions: 2 } });
    h.api.addChannel({ members: [ADA.id] });
    const lounges = [1, 2, 3].map(() => h!.api.addChannel({ members: [BEN.id] }));
    const ada = await h.open(ADA.cookie);
    for (const channel_id of lounges) ada.send({ type: "subscribe", channel_id });
    await ada.waitFor((f) => f.type === "error");
    // The refusal needs no API call, so it can arrive before the two answers do.
    await waitUntil(() => ada.of("subscribed").length === 2);
    expect(ada.of("error")[0]).toMatchObject({ code: "too_many_subscriptions", channel_id: lounges[2] });
  });

  it("believes a refusal only for a while", async () => {
    h = await startHarness({ config: { accessTtlMs: 150 } });
    h.api.addChannel({ members: [ADA.id] });
    const room = h.api.addChannel({ kind: "private", members: [BEN.id] });
    const ada = await h.open(ADA.cookie);
    ada.send({ type: "subscribe", channel_id: room });
    await ada.next("error");
    h.api.channels.get(room)!.members.add(ADA.id);
    await settle(250);
    ada.send({ type: "subscribe", channel_id: room });
    await ada.next("subscribed");
  });

  it("remembers only so many refusals, so guessing IDs can't grow its memory", async () => {
    h = await startHarness({ config: { rateFrames: 10_000 } });
    h.api.addChannel({ members: [ADA.id] });
    const first = randomUUID();
    const ada = await h.open(ADA.cookie);
    const refuse = async (channel_id: string) => {
      const answered = ada.of("error").length;
      ada.send({ type: "subscribe", channel_id });
      await waitUntil(() => ada.of("error").length > answered);
    };

    await refuse(first);
    await refuse(first); // remembered: not asked again
    expect(channelRequests(h, first)).toHaveLength(1);
    for (let i = 0; i < 200; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, as a client would
      await refuse(randomUUID());
    }
    await refuse(first); // long forgotten by now: asked again
    expect(channelRequests(h, first)).toHaveLength(2);
  });

  it("explains a frame it can't use", async () => {
    h = await startHarness();
    const ada = await h.open(ADA.cookie);
    ada.send({ type: "subscribe", channel_id: "not-a-uuid" });
    ada.send({ type: "subscribe" });
    ada.send({ type: "publish", channel_id: randomUUID(), body: "hi" });
    ada.socket.send("[]");
    await settle();
    expect(ada.of("error")).toHaveLength(4);
    expect(ada.of("error").every((frame) => frame.code === "bad_request")).toBe(true);
    expect(ada.closeCode).toBeUndefined();
  });

  it("limits how fast one socket can send frames", async () => {
    h = await startHarness({ config: { rateFrames: 5, rateWindowMs: 10_000 } });
    const ada = await h.open(ADA.cookie);
    for (let i = 0; i < 10; i += 1) ada.send({ type: "ping" });
    expect(await ada.closed()).toBe(CloseCode.tooManyRequests);
  });

  it("doesn't take a message over the socket: sending goes through the API", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id, BEN.id] });
    const ada = await h.open(ADA.cookie);
    const ben = await h.open(BEN.cookie);
    ada.send({ type: "message.created", channel_id: home, body_html: "<p>hi</p>" });
    ada.send({ type: "event", event: chatEvent("message.created", { channel_id: home }) });
    await settle();
    expect(eventsOf(ada)).toEqual([]);
    expect(eventsOf(ben)).toEqual([]);
    expect(ada.of("error")).toHaveLength(2);
  });
});
