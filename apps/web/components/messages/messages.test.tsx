/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { runInAction } from "mobx";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TChatChannel, TChatMessage } from "@plane/types";
import { ChatStore } from "@/store/chat.store";
import type { TChatStoreService, TChatStoreSocket } from "@/store/chat.store";

const ME = "user-me";
const ADA = "user-ada";

const mocks = vi.hoisted(() => ({
  chat: undefined as unknown as ChatStore,
  push: (() => undefined) as (href: string) => void,
}));

vi.mock("@/hooks/store/use-chat", () => ({ useChat: () => mocks.chat }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: (href: string) => mocks.push(href) }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws-1" }) }),
}));
vi.mock("@/hooks/store/use-member", () => {
  const users: Record<string, { id: string; display_name: string; first_name: string; last_name: string }> = {
    "user-me": { id: "user-me", display_name: "Me", first_name: "", last_name: "" },
    "user-ada": { id: "user-ada", display_name: "Ada", first_name: "Ada", last_name: "Lovelace" },
    "user-bob": { id: "user-bob", display_name: "Bob", first_name: "Bob", last_name: "" },
  };
  return {
    useMember: () => ({
      getUserDetails: (id: string) => users[id],
      workspace: {
        workspaceMemberIds: Object.keys(users),
        getWorkspaceMemberDetails: (id: string) => ({ id, role: 15, is_active: true, member: users[id] }),
      },
    }),
  };
});
// The rich-text editor is Plane's own and tested there; here a message body is just its HTML as text.
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: ({ initialValue, id }: { initialValue: string; id: string }) => (
    <div data-testid={id}>{initialValue.replace(/<[^>]+>/g, "")}</div>
  ),
}));

// Imported after the mocks are declared (vi.mock is hoisted above these anyway).
const { ChannelSidebar } = await import("./channel-sidebar");
const { ChatChannelView } = await import("./channel-view");
const { ChatConnectionBanner } = await import("./connection-banner");
const { CreateChannelDialog } = await import("./create-channel-dialog");
const { ChatMessageList } = await import("./message-list");
const { ChatUnreadCount } = await import("./unread-badge");

const channel = (overrides: Partial<TChatChannel>): TChatChannel => ({
  id: "c-general",
  workspace: "ws-1",
  kind: "public",
  name: "general",
  description: "",
  project: null,
  archived_at: null,
  created_by: ME,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  is_member: true,
  my_role: "member",
  last_read_message_id: null,
  unread_count: 0,
  last_message_at: null,
  member_count: 3,
  dm_member_ids: [],
  ...overrides,
});

const message = (id: string, sender: string, text: string, minute: number, extra: Partial<TChatMessage> = {}) => {
  const at = new Date(2026, 0, 5, 9, minute).toISOString();
  return {
    id,
    workspace: "ws-1",
    channel: "c-general",
    sender,
    sender_agent: null,
    body_html: `<p>${text}</p>`,
    body_json: {},
    body_stripped: text,
    parent: null,
    reply_count: 0,
    last_reply_at: null,
    edited_at: null,
    removed_at: null,
    created_at: at,
    updated_at: at,
    ...extra,
  } satisfies TChatMessage;
};

const notCalled = () => Promise.reject(new Error("not expected in this test"));

function makeStore(service: Partial<TChatStoreService> = {}) {
  const socket: TChatStoreSocket = {
    connect: vi.fn(),
    close: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    reconnectNow: vi.fn(),
  };
  const fullService = {
    me: notCalled,
    listChannels: async () => [],
    getChannel: notCalled,
    createChannel: notCalled,
    openDm: notCalled,
    joinChannel: notCalled,
    leaveChannel: notCalled,
    markRead: notCalled,
    listMessages: async () => ({ results: [], has_more: false }),
    getMessage: notCalled,
    sendMessage: notCalled,
    editMessage: notCalled,
    removeMessage: notCalled,
    ...service,
  } as TChatStoreService;
  const store = new ChatStore({ service: fullService, createSocket: () => socket });
  return { store, socket };
}

async function started(store: ChatStore, channels: TChatChannel[]) {
  await store.start("acme", ME);
  runInAction(() => {
    store.me = {
      workspace_id: "ws-1",
      workspace_role: 15,
      is_workspace_admin: false,
      can_create_channels: true,
      can_open_dms: true,
    };
    store.channelMap = Object.fromEntries(channels.map((c) => [c.id, c]));
    store.channelsLoaded = true;
  });
}

const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

// The test setup has no ICU formatter, so `t()` returns a template with placeholders as they are (agents' tests see
// "{provider} API key" too). Strings with values are matched by their fixed part.
const byTemplate = (fixed: string) => (content: string) => content.includes(fixed);

beforeEach(() => {
  mocks.push = () => undefined;
});

describe("ChatUnreadCount", () => {
  it("shows the count, caps it, and hides at zero", () => {
    const { rerender, container } = render(<ChatUnreadCount count={3} />);
    expect(container.querySelector("[aria-label]")?.textContent).toBe("3");
    rerender(<ChatUnreadCount count={150} />);
    expect(screen.getByText("99+")).toBeTruthy();
    rerender(<ChatUnreadCount count={0} />);
    expect(container.textContent).toBe("");
  });
});

describe("ChatConnectionBanner", () => {
  it("says nothing while connected, and why live updates stopped otherwise", async () => {
    const onReconnect = vi.fn();
    const { rerender, container } = render(
      <ChatConnectionBanner status="ready" closedReason={null} onReconnect={onReconnect} />
    );
    expect(container.textContent).toBe("");

    rerender(<ChatConnectionBanner status="reconnecting" closedReason={null} onReconnect={onReconnect} />);
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");
    await userEvent.click(screen.getByRole("button", { name: "Reconnect now" }));
    expect(onReconnect).toHaveBeenCalled();

    rerender(<ChatConnectionBanner status="closed" closedReason="unauthenticated" onReconnect={onReconnect} />);
    expect(screen.getByRole("status").textContent).toContain("Sign in again");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ChannelSidebar", () => {
  it("lists joined channels and DMs with their unread counts", async () => {
    const { store } = makeStore();
    mocks.chat = store;
    await started(store, [
      channel({ id: "c-general", name: "general", unread_count: 2 }),
      channel({ id: "c-secret", name: "secret", kind: "private" }),
      channel({ id: "c-open", name: "open", is_member: false }),
      channel({ id: "dm-1", kind: "dm", name: "", dm_member_ids: [ADA, ME], unread_count: 1 }),
    ]);
    inRouter(<ChannelSidebar workspaceSlug="acme" activeChannelId="c-secret" />);

    const channels = screen.getByRole("heading", { name: "Channels" }).closest("section")!;
    const links = within(channels).getAllByRole("link");
    // The public channel the user hasn't joined is in Browse, not here.
    expect(links.map((link) => link.textContent)).toEqual(["general2", "secret"]);
    expect(links[0]!.getAttribute("href")).toBe("/acme/messages/c-general/");
    expect(links[1]!.getAttribute("aria-current")).toBe("page");
    expect(links[0]!.querySelector("[aria-label]")?.textContent).toBe("2");
    expect(links[1]!.querySelector("[aria-label]")).toBeNull();

    const dms = screen.getByRole("heading", { name: "Direct messages" }).closest("section")!;
    expect(within(dms).getByRole("link").textContent).toContain("Ada");
  });

  it("hides create for someone who can't create channels", async () => {
    const { store } = makeStore();
    mocks.chat = store;
    await started(store, []);
    runInAction(() => {
      store.me = { ...store.me!, can_create_channels: false, can_open_dms: false };
    });
    inRouter(<ChannelSidebar workspaceSlug="acme" activeChannelId={undefined} />);
    expect(screen.queryByRole("button", { name: "Create a channel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Browse channels" })).toBeTruthy();
    expect(screen.getByText("You haven't joined any channels yet.")).toBeTruthy();
  });
});

describe("CreateChannelDialog", () => {
  it("requires a name, then creates the channel and opens it", async () => {
    const createChannel = vi.fn(async (_slug: string, data: { name: string; kind?: string }) =>
      channel({ id: "c-new", name: data.name, kind: data.kind as "private" })
    );
    const { store } = makeStore({ createChannel });
    mocks.chat = store;
    await started(store, []);
    const push = vi.fn();
    mocks.push = push;
    const onClose = vi.fn();
    render(<CreateChannelDialog workspaceSlug="acme" onClose={onClose} />);

    await userEvent.click(await screen.findByRole("button", { name: "Create channel" }));
    expect(await screen.findByText("A channel needs a name.")).toBeTruthy();
    expect(createChannel).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox", { name: /^Name/ }), "  launch  ");
    await userEvent.click(screen.getByRole("switch", { name: "Private channel" }));
    await userEvent.click(screen.getByRole("button", { name: "Create channel" }));
    expect(createChannel).toHaveBeenCalledWith("acme", { name: "launch", description: "", kind: "private" });
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/acme/messages/c-new");
    expect(store.joinedChannels.map((c) => c.id)).toEqual(["c-new"]);
  });
});

describe("ChatMessageList", () => {
  it("groups messages, shows a deleted message as such, and the pending ones last", async () => {
    const { store } = makeStore({
      listMessages: async () => ({
        results: [
          message("m1", ADA, "first", 0),
          message("m2", ADA, "second", 1),
          message("m3", ME, "", 2, { removed_at: "2026-01-05T09:03:00Z", body_html: "" }),
          message("m4", ADA, "edited one", 3, { edited_at: "2026-01-05T09:04:00Z", reply_count: 2 }),
        ],
        has_more: false,
      }),
      markRead: async () => channel({}),
      sendMessage: () => new Promise(() => undefined),
    });
    mocks.chat = store;
    await started(store, [channel({})]);
    await store.openChannel("c-general");
    void store.sendMessage("c-general", { body_html: "<p>on its way</p>" });

    render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={<p>start of general</p>} />);
    const log = screen.getByRole("log");
    expect(within(log).getByText("start of general")).toBeTruthy();
    const items = within(log).getAllByRole("article");
    // m2 continues m1: one name for both.
    expect(within(log).getAllByText("Ada")).toHaveLength(2);
    expect(items).toHaveLength(5);
    expect(within(items[2]!).getByText("This message was deleted.")).toBeTruthy();
    expect(within(items[3]!).getByText("(edited)")).toBeTruthy();
    expect(within(items[3]!).getByText(byTemplate("reply"))).toBeTruthy();
    expect(items[4]!.getAttribute("aria-label")).toBe("Sending…");
    expect(within(items[4]!).getByText("on its way")).toBeTruthy();
  });
});

describe("ChatChannelView", () => {
  it("offers Join instead of the composer in a public channel the user isn't in", async () => {
    const joinChannel = vi.fn(async () => channel({ id: "c-open", name: "open" }));
    const { store, socket } = makeStore({ joinChannel, markRead: async () => channel({ id: "c-open" }) });
    mocks.chat = store;
    await started(store, [channel({ id: "c-open", name: "open", is_member: false })]);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-open" />);

    expect(await screen.findByText(byTemplate("Join it to send messages."))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(socket.subscribe).toHaveBeenCalledWith("c-open");
    await userEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(joinChannel).toHaveBeenCalledWith("acme", "c-open");
    expect(await screen.findByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("says an archived channel can't take new messages", async () => {
    const { store } = makeStore();
    mocks.chat = store;
    await started(store, [channel({ archived_at: "2026-01-02T00:00:00Z" })]);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-general" />);
    expect(await screen.findByText(/This channel is archived/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave channel" })).toBeNull();
  });

  it("says so when the channel doesn't exist or isn't visible", async () => {
    const { ChatServiceError } = await import("@plane/services");
    const { store } = makeStore({ getChannel: () => Promise.reject(new ChatServiceError(404, {})) });
    mocks.chat = store;
    await started(store, []);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-missing" />);
    expect(await screen.findByText("Conversation not found")).toBeTruthy();
  });
});
