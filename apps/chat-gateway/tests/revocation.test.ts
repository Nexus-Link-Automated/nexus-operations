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

const message = (channel_id: string) => chatEvent("message.created", { channel_id, message_id: randomUUID() });

describe("access.revoked", () => {
  it("cuts a removed member off, and sends nothing in the meantime", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id, BEN.id] });
    const ada = await h.open(ADA.cookie);
    const ben = await h.open(BEN.cookie);

    // The API is slow to answer, so the re-check is still under way when the next events arrive.
    h.api.delayPaths.set(`/api/workspaces/${WORKSPACE_SLUG}/`, 150);
    h.api.members.delete(ADA.id);
    await h.publish(chatEvent("access.revoked", { user_id: ADA.id, actor_id: BEN.id }));
    await h.publish(message(home));
    await h.publish(message(home));

    expect(await ada.closed()).toBe(CloseCode.forbidden);
    expect(eventsOf(ada)).toEqual([]);
    expect(h.gateway.connectionCount).toBe(1);
    // Everyone else carries on.
    await waitUntil(() => eventsOf(ben).length === 2);
  });

  it("closes every tab of the user", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id] });
    const tabs = [await h.open(ADA.cookie), await h.open(ADA.cookie)];
    h.api.members.delete(ADA.id);
    await h.publish(chatEvent("access.revoked", { user_id: ADA.id }));
    expect(await Promise.all(tabs.map((tab) => tab.closed()))).toEqual([CloseCode.forbidden, CloseCode.forbidden]);
  });

  it("closes with 'sign in' when the cookie has gone too", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    h.api.users.delete(ADA.cookie);
    await h.publish(chatEvent("access.revoked", { user_id: ADA.id }));
    expect(await ada.closed()).toBe(CloseCode.unauthenticated);
  });

  it("leaves a user who is still a member alone, and has them refetch", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    await h.publish(chatEvent("access.revoked", { user_id: ADA.id }));
    expect(await ada.next("resync")).toEqual({ type: "resync", reason: "membership_changed" });
    expect(ada.closeCode).toBeUndefined();

    const later = message(home);
    await h.publish(later);
    await ada.waitFor((f) => f.type === "event");
    expect(eventsOf(ada)).toEqual([later]);
  });

  it("ignores it when it is about someone else", async () => {
    h = await startHarness();
    const home = h.api.addChannel({ members: [ADA.id, BEN.id] });
    const ada = await h.open(ADA.cookie);
    const before = h.api.requests.length;
    await h.publish(chatEvent("access.revoked", { user_id: BEN.id }));
    await h.publish(message(home));
    await ada.waitFor((f) => f.type === "event");
    expect(h.api.requests.length).toBe(before);
    expect(ada.of("resync")).toEqual([]);
  });

  it("closes the socket rather than guess when the API can't be asked", async () => {
    h = await startHarness();
    h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    h.api.failWith = 500;
    await h.publish(chatEvent("access.revoked", { user_id: ADA.id }));
    expect(await ada.closed()).toBe(CloseCode.internalError);
  });
});

describe("re-checking on a timer", () => {
  it("drops a followed channel the user can no longer see", async () => {
    h = await startHarness({ config: { accessTtlMs: 100 } });
    const home = h.api.addChannel({ members: [ADA.id] });
    const lounge = h.api.addChannel({ members: [BEN.id] });
    const ada = await h.open(ADA.cookie);
    ada.send({ type: "subscribe", channel_id: lounge });
    await ada.next("subscribed");

    h.api.channels.delete(lounge);
    expect(await ada.next("unsubscribed")).toEqual({ type: "unsubscribed", channel_id: lounge, reason: "access_lost" });
    await h.publish(message(lounge));
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toEqual([]);
  });

  it("notices a channel the user was put in without an event", async () => {
    h = await startHarness({ config: { accessTtlMs: 100 } });
    const home = h.api.addChannel({ members: [ADA.id] });
    const secret = h.api.addChannel({ kind: "private", members: [BEN.id] });
    const ada = await h.open(ADA.cookie);

    h.api.channels.get(secret)!.members.add(ADA.id);
    expect(await ada.next("resync")).toEqual({ type: "resync", reason: "membership_changed" });
    const hello = message(secret);
    await h.publish(hello);
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toEqual([hello]);
  });

  it("notices a channel the user was taken out of without an event", async () => {
    h = await startHarness({ config: { accessTtlMs: 100 } });
    const home = h.api.addChannel({ members: [ADA.id] });
    const team = h.api.addChannel({ kind: "private", members: [ADA.id] });
    const ada = await h.open(ADA.cookie);

    h.api.channels.get(team)!.members.delete(ADA.id);
    await ada.next("resync");
    await h.publish(message(team));
    await h.barrier(home, ada);
    expect(eventsOf(ada)).toEqual([]);
  });

  it("stays quiet while nothing has changed", async () => {
    h = await startHarness({ config: { accessTtlMs: 80 } });
    h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    await settle(400);
    expect(ada.of("resync")).toEqual([]);
    expect(h.api.requestsTo(`/api/workspaces/${WORKSPACE_SLUG}/chat/channels/?archived=false`).length).toBeGreaterThan(
      2
    );
  });

  it("doesn't mistake its own re-read for a change when an event got there first", async () => {
    h = await startHarness({ config: { accessTtlMs: 100 } });
    const home = h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    const fresh = h.api.addChannel({ kind: "private", members: [ADA.id] });
    await h.publish(chatEvent("member.added", { channel_id: fresh, user_id: ADA.id }));
    await h.barrier(home, ada);
    await settle(300);
    expect(ada.of("resync")).toEqual([]);
  });

  it("closes a socket whose cookie has expired", async () => {
    h = await startHarness({ config: { sessionRecheckMs: 100 } });
    h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    h.api.users.delete(ADA.cookie);
    expect(await ada.closed()).toBe(CloseCode.unauthenticated);
  });

  it("closes a socket whose user has left the workspace", async () => {
    h = await startHarness({ config: { sessionRecheckMs: 100 } });
    h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    h.api.members.delete(ADA.id);
    expect(await ada.closed()).toBe(CloseCode.forbidden);
  });

  it("closes a socket whose cookie now belongs to someone else", async () => {
    h = await startHarness({ config: { sessionRecheckMs: 100 } });
    h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    h.api.users.set(ADA.cookie, BEN.id);
    expect(await ada.closed()).toBe(CloseCode.unauthenticated);
  });

  it("keeps a socket open through an API outage, and says so in the log", async () => {
    h = await startHarness({ config: { sessionRecheckMs: 60, accessTtlMs: 60 } });
    const home = h.api.addChannel({ members: [ADA.id] });
    const ada = await h.open(ADA.cookie);
    h.api.failWith = 503;
    await settle(300);
    expect(ada.closeCode).toBeUndefined();
    expect(h.log.text()).toContain("could not re-check the session");
    h.api.failWith = undefined;

    const later = message(home);
    await h.publish(later);
    await ada.waitFor((f) => f.type === "event");
    expect(eventsOf(ada)).toEqual([later]);
  });
});
