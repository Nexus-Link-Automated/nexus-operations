/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { ChatServiceError } from "@plane/services";
import type { TChatMessage } from "@plane/types";
import {
  buildMessageRows,
  channelDisplayName,
  chatErrorMessage,
  chatMessagePermalink,
  chatSender,
  chatSenderName,
  defaultWorkItemAssignee,
  defaultWorkItemProject,
  localDay,
  unreadLabel,
  workItemTitleFromMessage,
} from "./helpers";

const message = (id: string, sender: string | null, at: Date, removed = false): TChatMessage => ({
  id,
  workspace: "w",
  channel: "c",
  sender,
  sender_agent: null,
  sender_agent_details: null,
  system_event: null,
  agent_notice: null,
  agent_streaming: false,
  agent_tool_calls: null,
  body_html: "<p>x</p>",
  body_json: {},
  body_stripped: "x",
  parent: null,
  reply_count: 0,
  last_reply_at: null,
  references: [],
  attachments: [],
  attachment_count: 0,
  edited_at: null,
  removed_at: removed ? at.toISOString() : null,
  created_at: at.toISOString(),
  updated_at: at.toISOString(),
});

// Local times, so the day dividers don't depend on the test machine's time zone.
const at = (day: number, hour: number, minute: number) => new Date(2026, 0, day, hour, minute);

const fromAgent = (id: string, slug: string, time: Date, name: string | null = "Release bot"): TChatMessage => ({
  ...message(id, null, time),
  sender_agent: slug,
  sender_agent_details: name ? { id: `a-${slug}`, slug, name, adapter: "codex", is_available: true } : null,
});

// `t` as the tests see it: the key itself, so which string was picked shows.
const t = (key: string) => key;

describe("chatSenderName", () => {
  const names: Record<string, string> = { ada: "Ada" };
  const getName = (id: string) => names[id];

  it("names a person, an agent from the registry, and an automatic post", () => {
    expect(chatSenderName(message("1", "ada", at(5, 9, 0)), getName, t)).toBe("Ada");
    expect(chatSenderName(fromAgent("2", "release", at(5, 9, 0)), getName, t)).toBe("Release bot");
    expect(chatSenderName({ ...message("3", null, at(5, 9, 0)), system_event: "work_item_state" }, getName, t)).toBe(
      "messages.message.automatic_sender"
    );
  });

  it("calls an agent the registry deleted a removed agent, never an unknown member", () => {
    expect(chatSenderName(fromAgent("1", "gone", at(5, 9, 0), null), getName, t)).toBe("messages.agent.removed");
    expect(chatSenderName(message("2", "bob", at(5, 9, 0)), getName, t)).toBe("messages.unknown_member");
  });

  it("tells the avatar which agent to show", () => {
    expect(chatSender(fromAgent("1", "release", at(5, 9, 0)))).toEqual({
      kind: "agent",
      name: "Release bot",
      adapter: "codex",
    });
    expect(chatSender(fromAgent("2", "gone", at(5, 9, 0), null))).toEqual({ kind: "agent", name: null, adapter: null });
    expect(chatSender(message("3", "ada", at(5, 9, 0)))).toEqual({ kind: "user", userId: "ada" });
  });
});

describe("buildMessageRows", () => {
  it("adds a divider per day and groups one sender's messages within five minutes", () => {
    const rows = buildMessageRows([
      message("1", "ada", at(5, 9, 0)),
      message("2", "ada", at(5, 9, 4)),
      message("3", "ada", at(5, 9, 10)),
      message("4", "bob", at(5, 9, 11)),
      message("5", "bob", at(6, 9, 12)),
    ]);
    expect(rows.map((r) => (r.kind === "day" ? r.day : `${r.message.id}${r.continued ? "+" : ""}`))).toEqual([
      "2026-01-05",
      "1",
      "2+",
      "3",
      "4",
      "2026-01-06",
      "5",
    ]);
  });

  it("groups one agent's messages, but not two agents' or an agent's with a person's", () => {
    const rows = buildMessageRows([
      fromAgent("1", "release", at(5, 9, 0)),
      fromAgent("2", "release", at(5, 9, 1)),
      fromAgent("3", "review", at(5, 9, 2)),
      message("4", "ada", at(5, 9, 3)),
      fromAgent("5", "review", at(5, 9, 4)),
    ]);
    expect(rows.flatMap((r) => (r.kind === "message" ? [r.continued] : []))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("starts a new block at midnight, and at exactly five minutes", () => {
    const rows = buildMessageRows([
      message("1", "ada", at(5, 23, 59)),
      message("2", "ada", at(6, 0, 1)),
      message("3", "ada", at(6, 0, 6)),
    ]);
    expect(rows.flatMap((r) => (r.kind === "message" ? [r.continued] : []))).toEqual([false, false, false]);
  });

  it("groups automatic posts of one kind, but never with a person's messages", () => {
    const automatic = (id: string, time: Date) => ({
      ...message(id, null, time),
      system_event: "work_item_state" as const,
    });
    const rows = buildMessageRows([
      automatic("1", at(5, 9, 0)),
      automatic("2", at(5, 9, 1)),
      message("3", "ada", at(5, 9, 2)),
      automatic("4", at(5, 9, 3)),
      message("5", null, at(5, 9, 4)),
      message("6", null, at(5, 9, 5)),
    ]);
    expect(rows.flatMap((r) => (r.kind === "message" ? [r.continued] : []))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("never groups across a removed message", () => {
    const rows = buildMessageRows([
      message("1", "ada", at(5, 9, 0)),
      message("2", "ada", at(5, 9, 1), true),
      message("3", "ada", at(5, 9, 2)),
    ]);
    expect(rows.filter((r) => r.kind === "message").map((r) => r.kind === "message" && r.continued)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe("localDay", () => {
  it("formats the local date", () => {
    expect(localDay(at(9, 23, 59).toISOString())).toBe("2026-01-09");
  });
});

describe("channelDisplayName", () => {
  const names: Record<string, string> = { ada: "Ada", bob: "Bob" };
  const getName = (id: string) => names[id];

  it("uses a channel's name", () => {
    expect(channelDisplayName({ kind: "public", name: "general", dm_member_ids: [] }, "me", getName, "?")).toBe(
      "general"
    );
  });

  it("names a DM after the other people, and falls back for someone unknown", () => {
    const dm = { kind: "group_dm" as const, name: "", dm_member_ids: ["ada", "me", "bob", "zed"] };
    expect(channelDisplayName(dm, "me", getName, "Unknown")).toBe("Ada, Bob, Unknown");
  });

  it("names an agent DM after its agent, or a removed agent once the registry deleted it", () => {
    const agent = { id: "a1", slug: "maia", name: "Maia", adapter: "claude" as const, is_available: true };
    const dm = { kind: "agent_dm" as const, name: "", dm_member_ids: ["me"] };
    expect(channelDisplayName({ ...dm, agent_dm: { agent } }, "me", getName, "Unknown", "Removed agent")).toBe("Maia");
    expect(channelDisplayName({ ...dm, agent_dm: { agent: null } }, "me", getName, "Unknown", "Removed agent")).toBe(
      "Removed agent"
    );
  });
});

describe("unreadLabel", () => {
  it("caps at 99+", () => {
    expect([1, 99, 100].map(unreadLabel)).toEqual(["1", "99", "99+"]);
  });
});

describe("chatErrorMessage", () => {
  it("reads a field error or the error text, and nothing from other errors", () => {
    expect(chatErrorMessage(new ChatServiceError(400, { name: ["A channel with this name already exists."] }))).toBe(
      "A channel with this name already exists."
    );
    expect(chatErrorMessage(new ChatServiceError(403, { error: "Guests can't create channels." }))).toBe(
      "Guests can't create channels."
    );
    expect(chatErrorMessage(new ChatServiceError(0, undefined))).toBeUndefined();
    expect(chatErrorMessage(new Error("x"))).toBeUndefined();
  });
});

describe("chatMessagePermalink", () => {
  it("links to the message in its channel", () => {
    expect(chatMessagePermalink("acme", { id: "m1", channel_id: "c1", parent_id: null })).toBe(
      "/acme/messages/c1?message=m1"
    );
  });

  it("links a thread reply to its thread's first message, the one the channel shows, and to the reply in it", () => {
    expect(chatMessagePermalink("acme", { id: "m2", channel_id: "c1", parent_id: "m1" })).toBe(
      "/acme/messages/c1?message=m1&reply=m2"
    );
  });
});

describe("pre-filling a work item from a message", () => {
  describe("workItemTitleFromMessage", () => {
    it("takes the first line, trimmed", () => {
      expect(workItemTitleFromMessage("  login is broken  \nsteps below")).toBe("login is broken");
    });

    it("fits Plane's title limit", () => {
      expect(workItemTitleFromMessage("x".repeat(400))).toHaveLength(255);
    });

    it("is empty for a message with no text", () => {
      expect(workItemTitleFromMessage("   ")).toBe("");
    });
  });

  describe("defaultWorkItemAssignee", () => {
    it("picks the first person mentioned who is in the project", () => {
      expect(defaultWorkItemAssignee(["outsider", "ada", "bob"], ["bob", "ada", "me"], "me")).toBe("ada");
    });

    it("falls back to whoever clicked", () => {
      expect(defaultWorkItemAssignee(["outsider"], ["me"], "me")).toBe("me");
      expect(defaultWorkItemAssignee([], ["me"], "me")).toBe("me");
    });

    it("assigns nobody when the clicker isn't in the project either", () => {
      expect(defaultWorkItemAssignee([], ["ada"], "me")).toBeNull();
      expect(defaultWorkItemAssignee([], ["ada"], null)).toBeNull();
    });
  });

  describe("defaultWorkItemProject", () => {
    it("prefers the channel's project, then the last used, then the first joined", () => {
      expect(defaultWorkItemProject("p2", "p3", ["p1", "p2", "p3"])).toBe("p2");
      expect(defaultWorkItemProject(null, "p3", ["p1", "p3"])).toBe("p3");
      expect(defaultWorkItemProject(null, null, ["p1", "p3"])).toBe("p1");
    });

    it("skips a project the user has left", () => {
      expect(defaultWorkItemProject("gone", "also-gone", ["p1"])).toBe("p1");
    });

    it("has no answer without projects", () => {
      expect(defaultWorkItemProject(null, null, [])).toBeUndefined();
    });
  });
});
