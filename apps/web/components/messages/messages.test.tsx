/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { runInAction } from "mobx";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { ChatService } from "@plane/services";
import type { TChatChannel, TChatEvent, TChatMessage } from "@plane/types";
import { ChatStore } from "@/store/chat.store";
import type { TChatStoreService, TChatStoreSocket } from "@/store/chat.store";

const ME = "user-me";
const ADA = "user-ada";
const BOB = "user-bob";
const GUS = "user-gus";

const mocks = vi.hoisted(() => ({
  chat: undefined as unknown as ChatStore,
  push: (() => undefined) as (href: string) => void,
  search: "",
  toast: vi.fn(),
  projects: {} as Record<string, { id: string; name: string }>,
  canLink: (_projectId: string): boolean => true,
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@plane/blocks/toast", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setToast: (toast: unknown) => mocks.toast(toast),
}));

vi.mock("@/hooks/store/use-chat", () => ({ useChat: () => mocks.chat }));
vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 5_242_880 }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: (href: string) => mocks.push(href) }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws-1" }) }),
}));
vi.mock("@/hooks/store/use-member", () => {
  const users: Record<string, { id: string; display_name: string; first_name: string; last_name: string }> = {
    "user-me": { id: "user-me", display_name: "Me", first_name: "", last_name: "" },
    "user-ada": { id: "user-ada", display_name: "Ada", first_name: "Ada", last_name: "Lovelace" },
    "user-bob": { id: "user-bob", display_name: "Bob", first_name: "Bob", last_name: "" },
    "user-gus": { id: "user-gus", display_name: "Gus", first_name: "Gus", last_name: "" },
  };
  return {
    useMember: () => ({
      getUserDetails: (id: string) => users[id],
      workspace: {
        workspaceMemberIds: Object.keys(users),
        // Gus is a guest.
        getWorkspaceMemberDetails: (id: string) => ({
          id,
          role: id === "user-gus" ? 5 : 15,
          is_active: true,
          member: users[id],
        }),
      },
    }),
  };
});
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    joinedProjectIds: Object.keys(mocks.projects),
    getProjectById: (id: string) => mocks.projects[id],
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({
    allowPermissions: (_roles: number[], _level: string, _slug: string, projectId: string) => mocks.canLink(projectId),
  }),
}));
// Plane's project picker is tested on its own; here it is a plain select over the projects it would offer.
vi.mock("@/components/dropdowns/project/project-select", () => ({
  ProjectSelect: ({
    value,
    onChange,
    filterOption,
    resolveProject,
  }: {
    value: string | null;
    onChange: (id: string | null) => void;
    filterOption: (id: string) => boolean;
    resolveProject: (id: string) => { name: string } | undefined;
  }) => (
    <select aria-label="Project" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">No project</option>
      {value && !mocks.projects[value] && <option value={value}>{resolveProject(value)?.name}</option>}
      {Object.values(mocks.projects)
        .filter((project) => filterOption(project.id))
        .map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
    </select>
  ),
}));
// The rich-text editor, in the composer and when editing a message, is Plane's own and tested there; here it shows
// its HTML as text. An editor asked to `autofocus` takes focus as it mounts, as Plane's does, and its handle gives back
// what it started with, so the composer can send a draft.
vi.mock("@/components/editor/lite-text", async () => {
  const { useEffect, useImperativeHandle, useRef } = await import("react");
  return {
    LiteTextEditor: function LiteTextEditor({
      initialValue,
      id,
      autofocus,
      ref,
    }: {
      initialValue: string;
      id: string;
      autofocus?: boolean;
      ref?: React.Ref<unknown>;
    }) {
      const element = useRef<HTMLDivElement>(null);
      useImperativeHandle(ref, () => ({
        getDocument: () => ({ html: initialValue, json: {} }),
        clearEditor: () => undefined,
      }));
      useEffect(() => {
        if (autofocus) element.current?.focus();
      }, [autofocus]);
      return (
        <div ref={element} tabIndex={-1} data-testid={id}>
          {new DOMParser().parseFromString(initialValue, "text/html").body.textContent}
        </div>
      );
    },
  };
});

// Imported after the mocks are declared (vi.mock is hoisted above these anyway).
const { ChannelSidebar } = await import("./channel-sidebar");
const { ChatChannelView } = await import("./channel-view");
const { ChatConnectionBanner } = await import("./connection-banner");
const { GuestDmAccessDialog } = await import("./guest-dm-access-dialog");
const { CreateChannelDialog } = await import("./create-channel-dialog");
const { ChatMessageList } = await import("./message-list");
const { BrowseChannelsDialog } = await import("./browse-channels-dialog");
const { ChatUnreadCount } = await import("./unread-badge");
const { MessagesRoot } = await import("./root");

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
    system_event: null,
    body_html: `<p>${text}</p>`,
    body_json: {},
    body_stripped: text,
    parent: null,
    reply_count: 0,
    last_reply_at: null,
    references: [],
    attachments: [],
    attachment_count: 0,
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
    noteActivity: vi.fn(),
  };
  const fullService = {
    uploadAttachment: notCalled,
    deleteAttachment: notCalled,
    me: notCalled,
    listChannels: async () => [],
    getChannel: notCalled,
    createChannel: notCalled,
    openDm: notCalled,
    joinChannel: notCalled,
    leaveChannel: notCalled,
    markRead: notCalled,
    listMessages: async () => ({ results: [], has_more: false }),
    listReplies: async () => ({ results: [], has_more: false }),
    getMessage: notCalled,
    sendMessage: notCalled,
    linkWorkItem: notCalled,
    editMessage: notCalled,
    removeMessage: notCalled,
    updateChannel: notCalled,
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

// The test setup has no ICU formatter, so `t()` returns a template with placeholders as they are (agents' tests see
// "{provider} API key" too). Strings with values are matched by their fixed part.
const byTemplate = (fixed: string) => (content: string) => content.includes(fixed);

beforeEach(() => {
  mocks.projects = {};
  mocks.canLink = () => true;
  mocks.push = () => undefined;
  mocks.search = "";
  mocks.toast.mockClear();
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
  it("says nothing about a socket closed for being idle, or on its way back", () => {
    const onReconnect = vi.fn();
    const { container, rerender } = render(
      <ChatConnectionBanner status="paused" closedReason={null} onReconnect={onReconnect} />
    );
    expect(container.firstChild).toBeNull();
    rerender(<ChatConnectionBanner status="connecting" closedReason={null} onReconnect={onReconnect} />);
    expect(container.firstChild).toBeNull();
  });

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

  it("links the new channel to a project the user may link", async () => {
    mocks.projects = { "p-gw": { id: "p-gw", name: "Gateway" }, "p-guest": { id: "p-guest", name: "Guest only" } };
    mocks.canLink = (id) => id === "p-gw";
    const createChannel = vi.fn(async () => channel({ id: "c-new", name: "gateway", project: "p-gw" }));
    const { store } = makeStore({ createChannel });
    mocks.chat = store;
    await started(store, []);
    render(<CreateChannelDialog workspaceSlug="acme" onClose={() => undefined} />);

    const select = screen.getByRole("combobox", { name: "Project" });
    // A project where the user is only a guest isn't offered.
    expect(within(select).queryByRole("option", { name: "Guest only" })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: /^Name/ }), "gateway");
    await userEvent.selectOptions(select, "p-gw");
    await userEvent.click(screen.getByRole("button", { name: "Create channel" }));
    expect(createChannel).toHaveBeenCalledWith("acme", {
      name: "gateway",
      description: "",
      kind: "public",
      project: "p-gw",
    });
  });
});

const rowEls = () => [...document.querySelectorAll("[data-message-id]")];
const idOf = (row: Element) => row.getAttribute("data-message-id")!;
const isList = (el: Element) => el.getAttribute("role") === "log";
const page = (ids: string[]) => ids.map((id, index) => message(id, ADA, id, index));

describe("ChatMessageList", () => {
  describe("attachments", () => {
    const image = {
      id: "a1",
      name: "photo.png",
      type: "image/png",
      size: 2048,
      preview_url: "/api/workspaces/acme/chat/channels/c/attachments/a1/?preview=1",
      download_url: "/api/workspaces/acme/chat/channels/c/attachments/a1/",
    };
    const svg = {
      ...image,
      id: "a2",
      name: "logo.svg",
      type: "image/svg+xml",
      preview_url: null,
      download_url: "/api/workspaces/acme/chat/channels/c/attachments/a2/",
    };

    const renderMessage = async (extra: Partial<TChatMessage>) => {
      const { store } = makeStore({
        listMessages: async () => ({ results: [message("m1", ADA, "hello", 0, extra)], has_more: false }),
        markRead: async () => channel({}),
      });
      mocks.chat = store;
      await started(store, [channel({})]);
      await store.openChannel("c-general");
      inRouter(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
    };

    it("previews a raster image through the API, and only that", async () => {
      await renderMessage({ attachments: [image], attachment_count: 1 });
      const preview = await screen.findByRole("img", { name: "photo.png" });
      expect(preview.getAttribute("src")).toContain("?preview=1");
    });

    it("shows a file that can't be previewed as a download, with no inline rendering", async () => {
      await renderMessage({ attachments: [svg], attachment_count: 1 });
      await screen.findByText("logo.svg");
      expect(screen.queryByRole("img", { name: "logo.svg" })).toBeNull();
      expect(screen.getByRole("link", { name: byTemplate("Download") }).getAttribute("href")).toContain("/a2/");
    });

    it("shows nothing but the file for a message with no text", async () => {
      await renderMessage({ body_html: "<p></p>", body_stripped: "", attachments: [svg], attachment_count: 1 });
      await screen.findByText("logo.svg");
      expect(screen.queryByTestId("chat-message-m1")).toBeNull();
    });

    it("tells someone outside the channel how many files there are, and shows none", async () => {
      await renderMessage({ attachments: [], attachment_count: 2 });
      await screen.findByText(byTemplate("Join the channel to view"));
      expect(screen.queryByRole("link", { name: byTemplate("Download") })).toBeNull();
    });

    it("shows no files on a removed message", async () => {
      // Whatever a stale copy still carries: the API already sends none.
      await renderMessage({
        attachments: [image],
        attachment_count: 1,
        removed_at: "2026-01-05T09:03:00Z",
        body_html: "",
      });
      await screen.findByText(byTemplate("deleted"));
      expect(screen.queryByRole("img", { name: "photo.png" })).toBeNull();
    });
  });

  describe("work item references", () => {
    const reference = {
      id: "i1",
      project: "p1",
      key: "EMP-142",
      name: "Fix the gateway",
      priority: "high" as const,
      state: { name: "In Review", group: "started" as const, color: "#f59e0b" },
    };

    const renderMessage = async (extra: Partial<TChatMessage>) => {
      const { store } = makeStore({
        listMessages: async () => ({ results: [message("m1", ADA, "see EMP-142", 0, extra)], has_more: false }),
        markRead: async () => channel({}),
      });
      mocks.chat = store;
      await started(store, [channel({})]);
      await store.openChannel("c-general");
      inRouter(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
    };

    it("shows a card for each reference the server sent", async () => {
      await renderMessage({ references: [reference] });
      expect(screen.getByText("Fix the gateway")).toBeTruthy();
      expect(screen.getByRole("link", { name: /EMP-142/ }).getAttribute("href")).toBe("/acme/browse/EMP-142/");
    });

    it("shows no card, only the text, when the server sent none", async () => {
      await renderMessage({ references: [] });
      expect(screen.queryByText("Fix the gateway")).toBeNull();
      expect(screen.queryByRole("link", { name: /EMP-142/ })).toBeNull();
    });

    it("shows no card on a removed message", async () => {
      await renderMessage({ references: [reference], removed_at: "2026-01-05T09:03:00Z", body_html: "" });
      expect(screen.queryByText("Fix the gateway")).toBeNull();
    });
  });

  describe("while message bodies render after their rows", () => {
    const VIEWPORT = 300;
    /** A row before its editor has rendered, and after. */
    const SHELL = 20;
    const RENDERED = 100;

    let heights: Map<string, number>;
    let scrollTop: number;
    let onResize: Set<ResizeObserverCallback>;
    let restore: (() => void)[];

    const heightOf = (row: Element) => heights.get(idOf(row)) ?? SHELL;
    const contentHeight = () => rowEls().reduce((sum, row) => sum + heightOf(row), 0);
    const maxScroll = () => Math.max(0, contentHeight() - VIEWPORT);
    /** Where a row is on screen. */
    const topOf = (id: string) => {
      const rows = rowEls();
      const above = rows.slice(
        0,
        rows.findIndex((row) => idOf(row) === id)
      );
      return above.reduce((sum, row) => sum + heightOf(row), 0) - scrollTop;
    };
    const renderBodies = (ids: string[]) => {
      for (const id of ids) heights.set(id, RENDERED);
    };
    /** What the browser does once layout has seen the new height. */
    const resized = () => {
      for (const callback of onResize) callback([], {} as ResizeObserver);
    };
    const scrollTo = (top: number) => {
      scrollTop = top;
      fireEvent.scroll(screen.getByRole("log"));
    };

    const stub = (target: object, property: string, kind: "get" | "set", implementation: unknown) => {
      const spy = vi.spyOn(target as Record<string, number>, property as never, kind as "get");
      spy.mockImplementation(implementation as () => never);
      restore.push(() => spy.mockRestore());
    };

    // jsdom has no layout, so the list's geometry comes from `heights`. Rows start as shells, as they do in a browser.
    beforeEach(() => {
      heights = new Map();
      scrollTop = 0;
      onResize = new Set();
      restore = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private readonly callback: ResizeObserverCallback) {
            onResize.add(callback);
          }
          observe() {}
          unobserve() {}
          disconnect() {
            onResize.delete(this.callback);
          }
        }
      );
      stub(Element.prototype, "clientHeight", "get", () => VIEWPORT);
      stub(Element.prototype, "scrollHeight", "get", () => Math.max(contentHeight(), VIEWPORT));
      stub(Element.prototype, "scrollTop", "get", () => scrollTop);
      stub(Element.prototype, "scrollTop", "set", (value: number) => {
        scrollTop = Math.min(Math.max(0, value), maxScroll());
      });
      stub(HTMLElement.prototype, "offsetHeight", "get", () => contentHeight());
      const realRect = Element.prototype.getBoundingClientRect;
      const rect = vi.spyOn(Element.prototype, "getBoundingClientRect");
      rect.mockImplementation(function (this: Element) {
        if (isList(this)) return { top: 0, bottom: VIEWPORT } as DOMRect;
        if (!this.hasAttribute("data-message-id")) return realRect.call(this);
        const top = topOf(idOf(this));
        return { top, bottom: top + heightOf(this) } as DOMRect;
      });
      restore.push(() => rect.mockRestore());
    });

    afterEach(() => {
      for (const undo of restore) undo();
      vi.unstubAllGlobals();
    });

    const open = async (service: Partial<TChatStoreService>) => {
      const { store } = makeStore({ markRead: async () => channel({}), ...service });
      mocks.chat = store;
      await started(store, [channel({})]);
      await store.openChannel("c-general");
      render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
      return store;
    };

    const NEWEST = ["m5", "m6", "m7", "m8", "m9"];
    const OLDER = ["m0", "m1", "m2", "m3", "m4"];
    const newestOnly = async () => ({ results: page(NEWEST), has_more: false });
    const incoming = (store: ChatStore, id: string) =>
      act(async () => {
        (store as unknown as { handleEvent: (e: TChatEvent) => void }).handleEvent({
          type: "message.created",
          workspace_id: "ws-1",
          channel_id: "c-general",
          message_id: id,
          actor_id: ADA,
          at: "2026-01-05T10:00:00Z",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    it("ends up at the newest message when a channel opens", async () => {
      await open({ listMessages: newestOnly });
      expect(scrollTop).toBe(0);

      renderBodies(NEWEST);
      resized();
      expect(scrollTop).toBe(200);
    });

    it("doesn't take the scroll event of the first pin for the user leaving the bottom", async () => {
      await open({ listMessages: newestOnly });
      renderBodies(NEWEST);
      fireEvent.scroll(screen.getByRole("log"));
      resized();
      expect(scrollTop).toBe(200);
    });

    it("follows a new message down when at the bottom", async () => {
      const store = await open({
        listMessages: newestOnly,
        getMessage: async () => message("m10", ADA, "new", 30),
      });
      renderBodies(NEWEST);
      resized();

      await incoming(store, "m10");
      renderBodies(["m10"]);
      resized();
      expect(scrollTop).toBe(300);
    });

    it("stays put for someone else's message when scrolled up", async () => {
      const store = await open({
        listMessages: newestOnly,
        getMessage: async () => message("m10", ADA, "new", 30),
      });
      renderBodies(NEWEST);
      resized();
      scrollTo(50);

      await incoming(store, "m10");
      renderBodies(["m10"]);
      resized();
      expect(scrollTop).toBe(50);
    });

    it("leaves a message unread while scrolled up, and reads it on scrolling back down", async () => {
      const markRead = vi.fn(async () => channel({}));
      const store = await open({
        listMessages: newestOnly,
        getMessage: async () => message("m10", ADA, "new", 30),
        markRead,
      });
      renderBodies(NEWEST);
      resized();
      scrollTo(50);
      expect(store.isAtNewest).toBe(false);
      markRead.mockClear();

      await incoming(store, "m10");
      renderBodies(["m10"]);
      resized();
      expect(store.channelMap["c-general"]!.unread_count).toBe(1);
      expect(markRead).not.toHaveBeenCalled();

      await act(async () => {
        scrollTo(maxScroll());
        await settle();
      });
      expect(store.isAtNewest).toBe(true);
      expect(markRead).toHaveBeenCalledWith("acme", "c-general", "m10");
    });

    it("comes back down for the user's own message when scrolled up", async () => {
      let deliver!: (sent: TChatMessage) => void;
      const store = await open({
        listMessages: newestOnly,
        sendMessage: () => new Promise((resolve) => (deliver = resolve)),
      });
      renderBodies(NEWEST);
      resized();
      scrollTo(50);

      await act(async () => void store.sendMessage("c-general", { body_html: "<p>new</p>" }));
      await act(async () => deliver(message("m10", ME, "new", 30)));
      renderBodies(["m10"]);
      resized();
      expect(scrollTop).toBe(300);
    });

    const scrolledUpWithOlderLoaded = async () => {
      const store = await open({
        listMessages: async (_slug, _channel, params) =>
          params?.before ? { results: page(OLDER), has_more: false } : { results: page(NEWEST), has_more: true },
      });
      renderBodies(NEWEST);
      resized();
      scrollTo(40);
      expect(topOf("m5")).toBe(-40);
      await act(() => store.loadOlderMessages("c-general"));
      expect(topOf("m5")).toBe(-40);
    };

    it("keeps the same messages on screen as older ones load above and then render", async () => {
      await scrolledUpWithOlderLoaded();
      renderBodies(OLDER);
      resized();
      expect(topOf("m5")).toBe(-40);
    });

    it("doesn't repeat a correction the browser's own scroll anchoring already made", async () => {
      await scrolledUpWithOlderLoaded();
      const before = topOf("m5");
      renderBodies(OLDER);
      scrollTop += topOf("m5") - before;
      resized();
      expect(topOf("m5")).toBe(-40);
    });

    it("keeps a linked message in place while the rows above it render", async () => {
      const ids = Array.from({ length: 30 }, (_, index) => `m${index}`);
      const real = Element.prototype.scrollIntoView;
      // oxlint-disable-next-line no-extend-native -- jsdom doesn't implement scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element) {
        scrollTop += topOf(idOf(this)) - 150;
      };
      restore.push(() => {
        // oxlint-disable-next-line no-extend-native -- put back what the line above replaced
        Element.prototype.scrollIntoView = real;
      });
      mocks.search = "message=m20";
      await open({ listMessages: async () => ({ results: page(ids), has_more: false }) });
      await vi.waitFor(() => expect(topOf("m20")).toBe(150));

      // In two passes, as the editors finish at different times.
      renderBodies(ids.slice(0, 10));
      resized();
      expect(topOf("m20")).toBe(150);
      renderBodies(ids.slice(10, 20));
      resized();
      expect(topOf("m20")).toBe(150);
    });

    it("goes back to following the bottom when a linked message can't be found", async () => {
      mocks.search = "message=gone";
      await open({ listMessages: newestOnly });
      await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
      renderBodies(NEWEST);
      resized();
      expect(scrollTop).toBe(200);
    });

    it("doesn't undo bringing a linked message into view", async () => {
      const real = Element.prototype.scrollIntoView;
      // oxlint-disable-next-line no-extend-native -- jsdom doesn't implement scrollIntoView
      Element.prototype.scrollIntoView = () => {
        scrollTop = 150;
      };
      restore.push(() => {
        // oxlint-disable-next-line no-extend-native -- put back what the line above replaced
        Element.prototype.scrollIntoView = real;
      });
      mocks.search = "message=m7";
      renderBodies(NEWEST);
      await open({ listMessages: newestOnly });
      expect(scrollTop).toBe(200);
      await vi.waitFor(() => expect(scrollTop).toBe(150));

      resized();
      expect(scrollTop).toBe(150);
    });
  });

  it("offers a retry instead of asking again by itself when an older page fails", async () => {
    let olderCalls = 0;
    const { store } = makeStore({
      listMessages: async (_slug, _channel, params) => {
        if (!params?.before) return { results: page(["m5"]), has_more: true };
        olderCalls += 1;
        if (olderCalls === 1) throw new Error("offline");
        return { results: page(["m1"]), has_more: false };
      },
      markRead: async () => channel({}),
    });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        // The top of the list is on screen, so every new observer reports it straight away.
        observe() {
          this.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          );
        }
        disconnect() {}
      }
    );
    mocks.chat = store;
    await started(store, [channel({})]);
    await store.openChannel("c-general");
    render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);

    const retry = await screen.findByRole("button", { name: "Try again" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(olderCalls).toBe(1);
    await userEvent.click(retry);
    await vi.waitFor(() => expect(olderCalls).toBe(2));
    vi.unstubAllGlobals();
  });

  it("shows an automatic message as Nexus's, with nothing to do but reply to it", async () => {
    const automatic = message("m1", ME, "EMP-142 moved to In Review", 0, {
      sender: null,
      system_event: "work_item_state",
    });
    const { store } = makeStore({
      listMessages: async () => ({ results: [automatic], has_more: false }),
      markRead: async () => channel({ my_role: "admin" }),
    });
    mocks.chat = store;
    await started(store, [channel({ my_role: "admin" })]);
    await store.openChannel("c-general");
    render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);

    const row = screen.getByRole("article");
    expect(within(row).getByText("Work item updates")).toBeTruthy();
    expect(within(row).getByText("Automatic")).toBeTruthy();
    expect(within(row).getByText("EMP-142 moved to In Review")).toBeTruthy();
    expect(
      within(row)
        .getAllByRole("button", { hidden: true })
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Reply in thread"]);
  });

  it("offers Edit and Delete only where the API would allow them", async () => {
    const results = [message("m1", ME, "mine", 0)];
    const renderIn = async (overrides: Partial<TChatChannel>) => {
      const { store } = makeStore({
        listMessages: async () => ({ results, has_more: false }),
        markRead: async () => channel(overrides),
      });
      mocks.chat = store;
      await started(store, [channel(overrides)]);
      await store.openChannel("c-general");
      return render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
    };

    const member = await renderIn({});
    expect(screen.getByRole("button", { name: "Edit message", hidden: true })).toBeTruthy();
    member.unmount();
    const archived = await renderIn({ archived_at: "2026-01-02T00:00:00Z" });
    expect(screen.queryByRole("button", { name: "Edit message", hidden: true })).toBeNull();
    archived.unmount();
    await renderIn({ is_member: false });
    expect(screen.queryByRole("button", { name: "Delete message", hidden: true })).toBeNull();
  });

  describe("opened from a link to one message", () => {
    const list = async (results: TChatMessage[]) => {
      const { store } = makeStore({
        listMessages: async () => ({ results, has_more: false }),
        markRead: async () => channel({}),
      });
      mocks.chat = store;
      await started(store, [channel({})]);
      await store.openChannel("c-general");
      return render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
    };

    it("highlights the message and brings it into view", async () => {
      const scrollIntoView = vi.fn();
      // oxlint-disable-next-line no-extend-native -- jsdom doesn't implement scrollIntoView
      Element.prototype.scrollIntoView = scrollIntoView;
      mocks.search = "message=m2";
      const { container } = await list([message("m1", ADA, "first", 0), message("m2", ADA, "second", 1)]);
      await vi.waitFor(() =>
        expect(container.querySelector('[data-message-id="m2"]')?.className).toContain("bg-accent-subtle")
      );
      expect(container.querySelector('[data-message-id="m1"]')?.className).not.toContain("bg-accent-subtle");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      expect(mocks.toast).not.toHaveBeenCalled();
    });

    it("brings it into view once, and lets the highlight go", async () => {
      const scrollIntoView = vi.fn();
      // oxlint-disable-next-line no-extend-native -- jsdom doesn't implement scrollIntoView
      Element.prototype.scrollIntoView = scrollIntoView;
      mocks.search = "message=m2";
      const { container } = await list([message("m1", ADA, "first", 0), message("m2", ADA, "second", 1)]);
      const row = () => container.querySelector('[data-message-id="m2"]')!;
      await vi.waitFor(() => expect(row().className).toContain("bg-accent-subtle"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 3_200)));
      expect(row().className).not.toContain("bg-accent-subtle");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    }, 6_000);

    it("says so once, however often the list renders afterwards", async () => {
      mocks.search = "message=gone";
      const { store } = makeStore({
        listMessages: async () => ({ results: [message("m1", ADA, "first", 0)], has_more: false }),
        markRead: async () => channel({}),
        sendMessage: () => new Promise(() => undefined),
      });
      mocks.chat = store;
      await started(store, [channel({})]);
      await store.openChannel("c-general");
      render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
      await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
      await act(async () => void store.sendMessage("c-general", { body_html: "<p>new</p>" }));
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(mocks.toast).toHaveBeenCalledTimes(1);
    });

    it("says the history couldn't load, rather than that the message is gone", async () => {
      mocks.search = "message=m0";
      const { store } = makeStore({
        listMessages: async (_slug, _channel, params) => {
          if (params?.before) throw new Error("offline");
          return { results: [message("m1", ADA, "first", 0)], has_more: true };
        },
        markRead: async () => channel({}),
      });
      mocks.chat = store;
      await started(store, [channel({})]);
      await store.openChannel("c-general");
      render(<ChatMessageList workspaceSlug="acme" channelId="c-general" intro={null} />);
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith({ type: "error", title: "Couldn't load messages." })
      );
    });

    it("says so when the message can't be found", async () => {
      mocks.search = "message=gone";
      const { container } = await list([message("m1", ADA, "first", 0)]);
      await vi.waitFor(() =>
        expect(mocks.toast).toHaveBeenCalledWith({ type: "error", title: "This message is no longer available." })
      );
      expect(container.querySelector(".bg-accent-subtle")).toBeNull();
    });

    it("highlights nothing without a link", async () => {
      const { container } = await list([message("m1", ADA, "first", 0)]);
      await settle();
      expect(container.querySelector(".bg-accent-subtle")).toBeNull();
      expect(mocks.toast).not.toHaveBeenCalled();
    });
  });

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

  it("shows the linked project to someone who can see it", async () => {
    mocks.projects = { "p-gw": { id: "p-gw", name: "Gateway" } };
    const { store } = makeStore();
    mocks.chat = store;
    await started(store, [channel({ project: "p-gw" }), channel({ id: "c-hidden", project: "p-secret" })]);
    const view = render(<ChatChannelView workspaceSlug="acme" channelId="c-general" />);
    expect(await screen.findByText("Gateway")).toBeTruthy();
    view.unmount();
    render(<ChatChannelView workspaceSlug="acme" channelId="c-hidden" />);
    await screen.findByText("general");
    expect(screen.queryByTitle(byTemplate("Linked to"))).toBeNull();
  });

  it("lets only an admin change the linked project", async () => {
    mocks.projects = { "p-gw": { id: "p-gw", name: "Gateway" } };
    const updateChannel = vi.fn(async (_slug: string, _id: string, data: { project?: string | null }) =>
      channel({ my_role: "admin", project: data.project ?? null })
    );
    const { store } = makeStore({ updateChannel });
    mocks.chat = store;
    await started(store, [channel({ my_role: "member", project: "p-gw" })]);
    const view = render(<ChatChannelView workspaceSlug="acme" channelId="c-general" />);
    await screen.findByText("Gateway");
    expect(screen.queryByRole("button", { name: "Channel settings" })).toBeNull();
    view.unmount();

    runInAction(() => (store.channelMap["c-general"]!.my_role = "admin"));
    render(<ChatChannelView workspaceSlug="acme" channelId="c-general" />);
    await userEvent.click(await screen.findByRole("button", { name: "Channel settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateChannel).toHaveBeenCalledWith("acme", "c-general", { project: null });
    await vi.waitFor(() => expect(store.channelMap["c-general"]?.project).toBeNull());
  });

  it("says so when the channel doesn't exist or isn't visible", async () => {
    const { ChatServiceError } = await import("@plane/services");
    const { store } = makeStore({ getChannel: () => Promise.reject(new ChatServiceError(404, {})) });
    mocks.chat = store;
    await started(store, []);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-missing" />);
    expect(await screen.findByText("Conversation not found")).toBeTruthy();
  });

  it("goes back to Messages after leaving a private channel", async () => {
    const { ChatServiceError } = await import("@plane/services");
    const push = vi.fn();
    mocks.push = push;
    const { store } = makeStore({
      leaveChannel: async () => undefined,
      getChannel: () => Promise.reject(new ChatServiceError(404, {})),
      markRead: async () => channel({ kind: "private" }),
    });
    mocks.chat = store;
    await started(store, [channel({ kind: "private" })]);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-general" />);

    await userEvent.click(await screen.findByRole("button", { name: "Leave channel" }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/acme/messages"));
  });
});

describe("BrowseChannelsDialog", () => {
  it("stays open during a join, then opens the channel", async () => {
    const push = vi.fn();
    mocks.push = push;
    const onClose = vi.fn();
    let finish!: (value: TChatChannel) => void;
    const { store } = makeStore({ joinChannel: () => new Promise((resolve) => (finish = resolve)) });
    mocks.chat = store;
    await started(store, [channel({ id: "c-open", name: "open", is_member: false })]);
    render(<BrowseChannelsDialog workspaceSlug="acme" onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Join" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(channel({ id: "c-open", name: "open" })));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/acme/messages/c-open");
  });
});

const channelMember = (user: string, role: "admin" | "member" = "member") => ({
  id: `cm-${user}`,
  channel: "c-secret",
  user,
  role,
  created_at: "2026-01-01T00:00:00Z",
});

describe("ChannelMembersDialog", () => {
  const secret = (overrides: Partial<TChatChannel> = {}) =>
    channel({ id: "c-secret", name: "secret", kind: "private", ...overrides });

  afterEach(() => vi.restoreAllMocks());

  const openMembers = async (overrides: Partial<TChatChannel>) => {
    const { store } = makeStore({ markRead: async () => secret(overrides) });
    mocks.chat = store;
    await started(store, [secret(overrides)]);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-secret" />);
    await userEvent.click(await screen.findByRole("button", { name: "Members" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("list", { name: "Members" });
    return dialog;
  };
  // Each row starts with its avatar's fallback initial.
  const listed = (dialog: HTMLElement) =>
    within(within(dialog).getByRole("list", { name: "Members" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);

  it("lists who is in a private channel, and adds people from the workspace", async () => {
    vi.spyOn(ChatService.prototype, "listMembers")
      .mockResolvedValueOnce([channelMember(ME), channelMember(ADA, "admin")])
      .mockResolvedValueOnce([channelMember(ME), channelMember(ADA, "admin"), channelMember(BOB)]);
    const addMembers = vi.spyOn(ChatService.prototype, "addMembers").mockResolvedValue([channelMember(BOB)]);
    const dialog = await openMembers({});

    expect(listed(dialog)).toEqual(["MMe (You)", "AAdaAdmin"]);
    // A plain member can add people, but not remove them.
    expect(within(dialog).queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: "Ada" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Bob" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(addMembers).toHaveBeenCalledWith("acme", "c-secret", [BOB]);
    await vi.waitFor(() => expect(listed(dialog)).toEqual(["MMe (You)", "AAdaAdmin", "BBob"]));
  });

  it("lets a channel admin remove someone else", async () => {
    vi.spyOn(ChatService.prototype, "listMembers")
      .mockResolvedValueOnce([channelMember(ME, "admin"), channelMember(ADA)])
      .mockResolvedValueOnce([channelMember(ME, "admin")]);
    const removeMember = vi.spyOn(ChatService.prototype, "removeMember").mockResolvedValue(undefined);
    const dialog = await openMembers({ my_role: "admin" });

    // Leaving is the header's job, not this list's.
    const remove = within(dialog).getAllByRole("button", { name: /^Remove/ });
    expect(remove).toHaveLength(1);
    await userEvent.click(remove[0]!);
    expect(removeMember).toHaveBeenCalledWith("acme", "c-secret", ADA);
    await vi.waitFor(() => expect(listed(dialog)).toEqual(["MMe (You)Admin"]));
  });

  it("only lists the members of an archived channel", async () => {
    vi.spyOn(ChatService.prototype, "listMembers").mockResolvedValue([channelMember(ME, "admin"), channelMember(ADA)]);
    const dialog = await openMembers({ my_role: "admin", archived_at: "2026-01-02T00:00:00Z" });
    expect(within(dialog).queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("says so when the members can't be loaded, and tries again", async () => {
    const listMembers = vi
      .spyOn(ChatService.prototype, "listMembers")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([channelMember(ME)]);
    const { store } = makeStore({ markRead: async () => secret() });
    mocks.chat = store;
    await started(store, [secret()]);
    render(<ChatChannelView workspaceSlug="acme" channelId="c-secret" />);
    await userEvent.click(await screen.findByRole("button", { name: "Members" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Couldn't load the members")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("list", { name: "Members" })).toBeTruthy();
    expect(listMembers).toHaveBeenCalledTimes(2);
  });
});

describe("GuestDmAccessDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the workspace's guests, and grants and revokes their DM access", async () => {
    vi.spyOn(ChatService.prototype, "listGuestDmAccess").mockResolvedValue([]);
    const grant = vi.spyOn(ChatService.prototype, "grantGuestDmAccess").mockResolvedValue({
      id: "g1",
      workspace: "ws-1",
      user: GUS,
      can_open_dms: true,
      created_at: "2026-01-01T00:00:00Z",
      created_by: ME,
      updated_at: "2026-01-01T00:00:00Z",
      updated_by: null,
    });
    const revoke = vi.spyOn(ChatService.prototype, "revokeGuestDmAccess").mockResolvedValue(undefined);
    render(<GuestDmAccessDialog workspaceSlug="acme" onClose={() => undefined} />);

    const toggle = await screen.findByRole("switch", { name: "Gus" });
    // Members can already open DMs: only guests are listed.
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(grant).toHaveBeenCalledWith("acme", GUS);
    await vi.waitFor(() =>
      expect(screen.getByRole("switch", { name: "Gus" }).getAttribute("aria-checked")).toBe("true")
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("switch", { name: "Gus" }).hasAttribute("data-disabled")).toBe(false)
    );
    await userEvent.click(screen.getByRole("switch", { name: "Gus" }));
    expect(revoke).toHaveBeenCalledWith("acme", GUS);
    await vi.waitFor(() =>
      expect(screen.getByRole("switch", { name: "Gus" }).getAttribute("aria-checked")).toBe("false")
    );
  });

  it("keeps the switch as it was when the change fails", async () => {
    vi.spyOn(ChatService.prototype, "listGuestDmAccess").mockResolvedValue([]);
    vi.spyOn(ChatService.prototype, "grantGuestDmAccess").mockRejectedValue(new Error("offline"));
    render(<GuestDmAccessDialog workspaceSlug="acme" onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Gus" }));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't change guest access" }))
    );
    expect(screen.getByRole("switch", { name: "Gus" }).getAttribute("aria-checked")).toBe("false");
  });

  it("is offered to workspace admins only", async () => {
    const { store } = makeStore();
    mocks.chat = store;
    await started(store, []);
    const { unmount } = inRouter(<ChannelSidebar workspaceSlug="acme" activeChannelId={undefined} />);
    expect(screen.queryByRole("button", { name: "Guest access" })).toBeNull();
    unmount();
    runInAction(() => {
      store.me = { ...store.me!, is_workspace_admin: true };
    });
    inRouter(<ChannelSidebar workspaceSlug="acme" activeChannelId={undefined} />);
    expect(screen.getByRole("button", { name: "Guest access" })).toBeTruthy();
  });
});

describe("ChatComposer", () => {
  it("starts from the channel's unsent draft, and forgets it once sent", async () => {
    const { store } = makeStore({
      markRead: async () => channel({}),
      sendMessage: () => new Promise(() => undefined),
    });
    mocks.chat = store;
    await started(store, [channel({}), channel({ id: "c-random", name: "random" })]);
    store.setDraft("c-general", "<p>half written</p>");

    const first = render(<ChatChannelView workspaceSlug="acme" channelId="c-random" />);
    expect((await screen.findByTestId("chat-composer-c-random")).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(true);
    first.unmount();

    render(<ChatChannelView workspaceSlug="acme" channelId="c-general" />);
    expect((await screen.findByTestId("chat-composer-c-general")).textContent).toBe("half written");
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send.hasAttribute("disabled")).toBe(false);
    await userEvent.click(send);
    expect(store.getDraft("c-general")).toBeUndefined();
  });
});

describe("threads", () => {
  const parent = (extra: Partial<TChatMessage> = {}) =>
    message("p1", ADA, "the parent", 0, { reply_count: 2, last_reply_at: "2026-01-05T09:05:00Z", ...extra });
  const replyTo = (id: string, text: string, minute: number, extra: Partial<TChatMessage> = {}) =>
    message(id, ADA, text, minute, { parent: "p1", ...extra });

  async function view(
    options: { top?: TChatMessage[]; replies?: TChatMessage[]; channel?: Partial<TChatChannel> } = {},
    service: Partial<TChatStoreService> = {}
  ) {
    const top = options.top ?? [parent(), message("m2", ADA, "next", 1)];
    const replies = options.replies ?? [replyTo("r1", "first reply", 2), replyTo("r2", "second reply", 3)];
    const { store } = makeStore({
      listMessages: async () => ({ results: top, has_more: false }),
      listReplies: async () => ({ results: replies, has_more: false }),
      getMessage: async (_slug, _channel, id) => [...top, ...replies].find((m) => m.id === id)!,
      markRead: async () => channel(options.channel ?? {}),
      ...service,
    });
    mocks.chat = store;
    await started(store, [channel(options.channel ?? {})]);
    const rendered = inRouter(<MessagesRoot workspaceSlug="acme" channelId="c-general" />);
    await within(await screen.findByRole("log", { name: "Messages" })).findAllByRole("article");
    return { store, ...rendered };
  }

  const panel = () => screen.getByRole("complementary", { name: "Thread" });

  it("shows a summary under a message with replies, and none under one without", async () => {
    await view();
    const [withReplies, without] = within(screen.getByRole("log", { name: "Messages" })).getAllByRole("article");
    const summary = within(withReplies!).getByRole("button", { name: byTemplate("reply") });
    expect(summary.textContent).toContain("Last reply");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(within(without!).queryByRole("button", { name: byTemplate("reply") })).toBeNull();
  });

  it("opens beside the conversation: the parent, its replies oldest first, and a focused reply box", async () => {
    const { store } = await view();
    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));

    const thread = await screen.findByRole("complementary", { name: "Thread" });
    const log = within(thread).getByRole("log", { name: "Replies" });
    await within(log).findByText("second reply");
    const rows = within(log).getAllByRole("article");
    expect(rows.map((row) => row.getAttribute("data-message-id"))).toEqual(["p1", "r1", "r2"]);
    // The parent shows no summary or Reply of its own in the thread.
    expect(within(rows[0]!).queryByRole("button", { name: byTemplate("reply"), hidden: true })).toBeNull();
    expect(within(rows[0]!).queryByRole("button", { name: "Reply in thread", hidden: true })).toBeNull();
    // Replies stay out of the channel.
    expect(within(screen.getByRole("log", { name: "Messages" })).queryByText("first reply")).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("chat-reply-p1");
    expect(store.activeThread).toEqual({ channelId: "c-general", parentId: "p1" });
  });

  it("starts a thread from Reply on a message without replies", async () => {
    const { store } = await view({ replies: [] });
    const next = within(screen.getByRole("log", { name: "Messages" })).getAllByRole("article")[1]!;
    await userEvent.click(within(next).getByRole("button", { name: "Reply in thread", hidden: true }));
    expect(store.activeThread?.parentId).toBe("m2");
    expect(await screen.findByRole("complementary", { name: "Thread" })).toBeTruthy();
  });

  it("closes with Escape or the close button, and Escape while editing only cancels the edit", async () => {
    const { store } = await view({ replies: [message("r1", ME, "my reply", 2, { parent: "p1" })] });
    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));
    await within(panel()).findByText("my reply");

    const mine = within(panel()).getAllByRole("article")[1]!;
    await userEvent.click(within(mine).getByRole("button", { name: "Edit message", hidden: true }));
    fireEvent.keyDown(within(mine).getByRole("group", { name: "Edit message" }), { key: "Escape" });
    expect(within(mine).queryByRole("group", { name: "Edit message" })).toBeNull();
    expect(store.activeThread).not.toBeNull();

    fireEvent.keyDown(within(panel()).getByTestId("chat-reply-p1"), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Thread" })).toBeNull();
    expect(store.activeThread).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));
    await userEvent.click(
      within(await screen.findByRole("complementary", { name: "Thread" })).getByRole("button", {
        name: "Close thread",
      })
    );
    expect(screen.queryByRole("complementary", { name: "Thread" })).toBeNull();
  });

  it("leaves the thread open when Escape closes a dialog opened from it", async () => {
    const { store } = await view({ replies: [message("r1", ME, "my reply", 2, { parent: "p1" })] });
    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));
    await within(panel()).findByText("my reply");
    const mine = within(panel()).getAllByRole("article")[1]!;
    await userEvent.click(within(mine).getByRole("button", { name: "Delete message", hidden: true }));
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    expect(store.activeThread).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Thread" })).toBeTruthy();
  });

  it("takes the conversation's place on a narrow screen instead of squeezing in beside it", async () => {
    await view();
    const conversation = screen.getByRole("log", { name: "Messages" }).parentElement!;
    expect(conversation.className).not.toContain("max-lg:hidden");
    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));
    await screen.findByRole("complementary", { name: "Thread" });
    expect(conversation.className).toContain("max-lg:hidden");
    expect(panel().className).toContain("w-full");
    expect(panel().className).toContain("lg:w-96");
  });

  it("shows a removed first message as removed, with its thread still reachable", async () => {
    await view({ top: [parent({ removed_at: "2026-01-05T09:06:00Z", body_html: "", body_stripped: "" })] });
    const removed = screen.getByText("This message was deleted.");
    const row = removed.closest("article")!;
    await userEvent.click(within(row).getByRole("button", { name: byTemplate("reply") }));
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    expect(await within(thread).findByText("first reply")).toBeTruthy();
    expect(within(thread).getByText("This message was deleted.")).toBeTruthy();
    expect(within(thread).getByTestId("chat-reply-p1")).toBeTruthy();
  });

  it("sends a reply into the thread, showing it pending, and offers Retry when it fails", async () => {
    const sendMessage = vi.fn((_slug: string, _channelId: string, _data: unknown) =>
      Promise.reject(new Error("offline"))
    );
    const { store } = await view({}, { sendMessage });
    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));
    await within(panel()).findByText("second reply");
    await act(async () => {
      await store.sendReply("c-general", "p1", { body_html: "<p>my answer</p>" }).catch(() => undefined);
    });
    expect(sendMessage).toHaveBeenCalledWith("acme", "c-general", {
      body_html: "<p>my answer</p>",
      body_json: {},
      parent_id: "p1",
    });
    const failed = within(panel()).getByRole("article", { name: "Not sent." });
    expect(within(failed).getByText("my answer")).toBeTruthy();
    expect(within(failed).getByRole("button", { name: "Retry" })).toBeTruthy();
    // Not in the channel.
    expect(within(screen.getByRole("log", { name: "Messages" })).queryByText("my answer")).toBeNull();
  });

  it("offers no reply box to a reader who hasn't joined, and focuses the panel instead", async () => {
    await view({ channel: { is_member: false } });
    await userEvent.click(screen.getByRole("button", { name: byTemplate("reply") }));
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    await within(thread).findByText("first reply");
    expect(within(thread).queryByTestId("chat-reply-p1")).toBeNull();
    expect(document.activeElement).toBe(within(thread).getByRole("heading", { name: "Thread" }));
  });

  it("says so when the linked thread is gone, and offers to try again", async () => {
    const { ChatServiceError } = await import("@plane/services");
    const gone = () => Promise.reject(new ChatServiceError(404, {}));
    const listReplies = vi.fn(gone);
    mocks.search = "message=p-gone&reply=r-gone";
    await view({}, { listReplies, getMessage: gone });
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    expect(await within(thread).findByText("This message is no longer available.")).toBeTruthy();
    expect(within(thread).queryByTestId("chat-reply-p-gone")).toBeNull();
    await userEvent.click(within(thread).getByRole("button", { name: "Try again" }));
    expect(listReplies).toHaveBeenCalledTimes(2);
  });

  it("opens the thread from a link to a reply, with the reply highlighted", async () => {
    const scrollIntoView = vi.fn();
    // oxlint-disable-next-line no-extend-native -- jsdom doesn't implement scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView;
    mocks.search = "message=p1&reply=r2";
    await view();
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    await vi.waitFor(() =>
      expect(thread.querySelector('[data-message-id="r2"]')?.className).toContain("bg-accent-subtle")
    );
    expect(thread.querySelector('[data-message-id="r1"]')?.className).not.toContain("bg-accent-subtle");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
