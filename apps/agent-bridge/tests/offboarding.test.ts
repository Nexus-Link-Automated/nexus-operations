/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it } from "vitest";

import { CloseCode } from "../src/proxy.ts";
import { initialize, startHarness, type Harness } from "./helpers/harness.ts";
import { OTHER_USER_ID, USER_ID, WORKSPACE_ID } from "./helpers/stub-api.ts";
import { waitUntil } from "./helpers/ws-client.ts";

const OTHER_WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const mine = { workspaceId: WORKSPACE_ID, userId: USER_ID };
const removed = { workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID };
const elsewhere = { workspaceId: OTHER_WORKSPACE_ID, userId: USER_ID };

describe("offboarding ended memberships", () => {
  it("offboards members with runner directories whose membership ended, and leaves current members alone", async () => {
    harness = await startHarness();
    harness.runner.memberDirs.push(mine, removed, elsewhere);
    const client = await harness.open();
    await initialize(client);

    const offboarded = await harness.bridge.sweepEndedMemberships();

    expect(offboarded).toEqual([removed, elsewhere]);
    expect(harness.runner.offboarded).toEqual([removed, elsewhere]);
    expect(harness.runner.memberDirs).toEqual([mine]);
    expect(harness.api.offboardingChecks).toEqual([
      [
        { workspace_id: WORKSPACE_ID, user_id: USER_ID },
        { workspace_id: WORKSPACE_ID, user_id: OTHER_USER_ID },
        { workspace_id: OTHER_WORKSPACE_ID, user_id: USER_ID },
      ],
    ]);
    expect(harness.bridge.connectionCount).toBe(1);
  });

  it("closes an ended member's open chats, revokes their token and clears their runner state", async () => {
    harness = await startHarness();
    const client = await harness.open();
    await initialize(client);
    expect(harness.bridge.connectionCount).toBe(1);

    harness.api.members.delete(USER_ID);
    const offboarded = await harness.bridge.sweepEndedMemberships();

    expect(await client.closed()).toBe(CloseCode.forbidden);
    expect(offboarded).toEqual([mine]);
    expect(harness.runner.offboarded).toEqual([mine]);
    expect(harness.bridge.connectionCount).toBe(0);
    expect(harness.api.revoked).toEqual([harness.api.minted[0]!.tokenId]);
    expect(harness.transport.agents[0]!.closed).toBe(true);
  });

  it("still closes open chats when the runner cannot list or offboard, and tries again next time", async () => {
    harness = await startHarness();
    harness.runner.membersStatus = 500;
    const client = await harness.open();
    await initialize(client);
    harness.api.members.delete(USER_ID);

    expect(await harness.bridge.sweepEndedMemberships()).toEqual([]);
    expect(await client.closed()).toBe(CloseCode.forbidden);
    expect(harness.log.lines.some((line) => line.message === "agent-bridge: could not offboard a member")).toBe(true);

    harness.runner.membersStatus = undefined;
    harness.runner.memberDirs.push(mine);
    expect(await harness.bridge.sweepEndedMemberships()).toEqual([mine]);
    expect(harness.runner.memberDirs).toEqual([]);
  });

  it("changes nothing when the API cannot say whose membership ended", async () => {
    harness = await startHarness();
    harness.api.offboardingStatus = 500;
    harness.api.members.delete(USER_ID);
    harness.runner.memberDirs.push(mine);

    expect(await harness.bridge.sweepEndedMemberships()).toEqual([]);
    expect(harness.runner.offboarded).toEqual([]);
    expect(harness.log.lines.some((line) => line.message === "agent-bridge: could not check memberships")).toBe(true);
  });

  it("sweeps on its own every offboardIntervalMs", async () => {
    harness = await startHarness({ config: { offboardIntervalMs: 50 } });
    harness.runner.memberDirs.push(removed);
    await waitUntil(() => harness!.runner.offboarded.length === 1);
    expect(harness.runner.offboarded).toEqual([removed]);
  });
});
