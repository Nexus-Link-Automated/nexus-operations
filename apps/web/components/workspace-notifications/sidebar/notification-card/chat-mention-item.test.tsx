/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notification: {} as Record<string, unknown>,
  markRead: vi.fn(),
  push: vi.fn(),
  peek: vi.fn(),
}));

vi.mock("@/hooks/store/notifications/use-notification", () => ({
  useNotification: () => ({ asJson: mocks.notification, markNotificationAsRead: mocks.markRead }),
}));
vi.mock("@/hooks/store/notifications", () => ({
  useWorkspaceNotifications: () => ({ setCurrentSelectedNotificationId: vi.fn() }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ getIsIssuePeeked: () => false, setPeekIssue: mocks.peek }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "w" }) }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: mocks.push }) }));
vi.mock("./options", () => ({ NotificationOption: () => null }));
vi.mock("./content", () => ({ NotificationContent: () => <span>work item content</span> }));

const { NotificationItem } = await import("./item");

const chatMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  channel_id: "c1",
  channel_name: "development",
  channel_kind: "public",
  parent_id: null,
  preview: "can you look at this",
  ...overrides,
});

const notification = (overrides: Record<string, unknown> = {}) => ({
  id: "n1",
  entity_name: "chat_message",
  read_at: null,
  created_at: "2026-11-08T09:00:00Z",
  triggered_by_details: { display_name: "Ada", first_name: "Ada" },
  data: { chat_message: chatMessage() },
  ...overrides,
});

// The test setup has no ICU formatter, so `t()` returns the template with its placeholders.
const textContaining = (fixed: string) => (content: string) => content.includes(fixed);

describe("a chat mention in the inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markRead.mockResolvedValue(undefined);
    mocks.notification = notification();
  });

  it("names the channel and shows the message", () => {
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    expect(screen.getByText(textContaining("mentioned you in #"))).toBeTruthy();
    expect(screen.getByText("can you look at this")).toBeTruthy();
  });

  it("doesn't call a direct message a channel", () => {
    mocks.notification = notification({
      data: { chat_message: chatMessage({ channel_kind: "dm", channel_name: null }) },
    });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    expect(screen.getByText(textContaining("in a direct message"))).toBeTruthy();
  });

  it("marks it read and goes to the message, without opening a work item", async () => {
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    await userEvent.click(screen.getByText("can you look at this"));
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/acme/messages/c1?message=m1"));
    expect(mocks.markRead).toHaveBeenCalledWith("acme");
    expect(mocks.peek).not.toHaveBeenCalled();
  });

  it("opens a mention in a thread reply on that reply", async () => {
    mocks.notification = notification({ data: { chat_message: chatMessage({ id: "r1", parent_id: "m1" }) } });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    await userEvent.click(screen.getByText("can you look at this"));
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/acme/messages/c1?message=m1&reply=r1"));
  });

  it("still goes to the message if marking it read fails", async () => {
    mocks.markRead.mockRejectedValue(new Error("offline"));
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    await userEvent.click(screen.getByText("can you look at this"));
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalled());
  });

  it("doesn't mark an already-read entry again", async () => {
    mocks.notification = notification({ read_at: "2026-11-08T10:00:00Z" });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    await userEvent.click(screen.getByText("can you look at this"));
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalled());
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("names and shows the agent that mentioned them, which has no user", () => {
    mocks.notification = notification({
      triggered_by_details: null,
      data: { chat_message: chatMessage({ sender_agent: { slug: "release", name: "Release bot", adapter: "codex" } }) },
    });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    expect(screen.getByRole("img", { name: "Release bot" })).toBeTruthy();
  });

  it("says an agent replied, for its reply in the person's agent DM", () => {
    mocks.notification = notification({
      triggered_by_details: null,
      data: {
        chat_message: chatMessage({
          channel_kind: "agent_dm",
          channel_name: "",
          sender_agent: { slug: "maia", name: "Maia", adapter: "claude" },
        }),
      },
    });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    expect(screen.getByText(/replied to you/)).toBeTruthy();
    expect(screen.queryByText(/mentioned you/)).toBeNull();
  });

  it("calls an agent the registry no longer has a removed agent", () => {
    mocks.notification = notification({
      triggered_by_details: null,
      data: { chat_message: chatMessage({ sender_agent: { slug: "gone", name: null, adapter: null } }) },
    });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    expect(screen.getByRole("img", { name: "Removed agent" })).toBeTruthy();
  });

  it("leaves work item notifications to the existing card", () => {
    mocks.notification = notification({
      entity_name: "issue",
      project: "p1",
      data: {
        issue: { id: "i1", identifier: "EMP", sequence_id: 7, name: "Fix it" },
        issue_activity: { field: "state", verb: "updated" },
      },
    });
    render(<NotificationItem workspaceSlug="acme" notificationId="n1" />);
    expect(screen.getByText("work item content")).toBeTruthy();
  });
});
