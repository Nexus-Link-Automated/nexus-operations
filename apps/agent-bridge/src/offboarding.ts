/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Logger } from "./logger.ts";
import { MAX_OFFBOARDING_BATCH, type MemberRef, type PlaneApi } from "./plane-api.ts";
import type { MemberRunner } from "./runner-login.ts";

export interface OffboardingSweepInput {
  readonly api: Pick<PlaneApi, "endedMemberships">;
  readonly runner: MemberRunner;
  /** Members with a chat open on this bridge right now. */
  readonly liveMembers: () => readonly MemberRef[];
  /** Close the member's open chats; resolves once they are closed. */
  readonly closeChats: (member: MemberRef) => Promise<void>;
  readonly log: Logger;
  /** Refuse a pass that would offboard more members than this. */
  readonly maxPerPass: number;
  readonly signal?: AbortSignal;
}

const keyOf = (member: MemberRef) => `${member.workspaceId}/${member.userId}`;

/**
 * One pass of offboarding: ask the API which of the members this bridge and the runner hold agent
 * state for no longer have an active membership, then close their chats and have the runner stop
 * and delete everything of theirs. The API decides; the runner's directory listing is what makes
 * memberships that ended while the bridge was down (or before this existed) get cleaned up too.
 * Failures are logged and left for the next pass.
 *
 * The API's answer is checked before anything is removed. A pass that would offboard more than
 * `maxPerPass` members, or every member known here when there are two or more, is refused and
 * logged: that is what an API pointed at the wrong or an empty database answers, and acting on it
 * would delete everyone's agent state. Returns the members offboarded.
 */
export async function sweepEndedMemberships(input: OffboardingSweepInput): Promise<MemberRef[]> {
  const { api, runner, log, signal } = input;
  const known = new Map<string, MemberRef>();
  try {
    for (const member of await runner.members(signal)) known.set(keyOf(member), member);
  } catch (error) {
    log.warn("agent-bridge: could not list the runner's members", { error: (error as Error).message });
  }
  for (const member of input.liveMembers()) known.set(keyOf(member), member);

  const all = [...known.values()];
  const ended = new Map<string, MemberRef>();
  for (let start = 0; start < all.length; start += MAX_OFFBOARDING_BATCH) {
    if (signal?.aborted) return [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      for (const member of await api.endedMemberships(all.slice(start, start + MAX_OFFBOARDING_BATCH), signal)) {
        // Only members this pass asked about can be offboarded.
        if (known.has(keyOf(member))) ended.set(keyOf(member), member);
      }
    } catch (error) {
      log.error("agent-bridge: could not check memberships", { error: (error as Error).message });
      return [];
    }
  }
  if (ended.size > input.maxPerPass || (ended.size >= 2 && ended.size === known.size)) {
    log.error("agent-bridge: refused to offboard members; the API reported too many ended memberships", {
      ended: ended.size,
      known: known.size,
      maxPerPass: input.maxPerPass,
    });
    return [];
  }

  const offboarded: MemberRef[] = [];
  for (const member of ended.values()) {
    if (signal?.aborted) break;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one member at a time
      await input.closeChats(member);
      // oxlint-disable-next-line no-await-in-loop -- one member at a time
      await runner.offboard(member, signal);
      offboarded.push(member);
      log.info("agent-bridge: offboarded a member whose workspace membership ended", { ...member });
    } catch (error) {
      log.error("agent-bridge: could not offboard a member", { ...member, error: (error as Error).message });
    }
  }
  return offboarded;
}
