/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatSession, AgentCloseCode } from "@plane/acp-client";
import { createFakeAgent, memoryTransport, type MemoryTransport } from "@plane/acp-client/testing";
import type { TWorkspaceAgent } from "@plane/types";
import { AgentChatStore } from "@/store/agent-chat.store";
import { AgentChatRoot } from "../root";
import { isAgentsPage, KhaiaWidget } from "./root";

const AGENTS: TWorkspaceAgent[] = [
  {
    id: "agent-1",
    name: "Claude",
    slug: "claude",
    description: "Anthropic's agent",
    adapter: "claude",
    default_permission_level: "ask_writes",
    max_permission_level: "ask_writes",
    credential_source: "workspace",
  },
  {
    id: "agent-2",
    name: "Codex",
    slug: "codex",
    description: "",
    adapter: "codex",
    default_permission_level: "ask_all",
    max_permission_level: "yolo",
    credential_source: "personal",
  },
  {
    id: "agent-3",
    name: "Gemini",
    slug: "gemini",
    description: "",
    adapter: "gemini",
    default_permission_level: "ask_writes",
    max_permission_level: "ask_writes",
    credential_source: null,
  },
];

// Outside the app, i18next runs without the ICU plugin, so "{name}" stays in the labels.
const OPEN = /^Open (Khaia|\{name\})$/;
const UNREAD = /^Open (Khaia|\{name\}) \(new activity\)$/;

let store: AgentChatStore;
vi.mock("@/hooks/store/use-agent-chat", () => ({ useAgentChat: () => store }));
// Admins and members may use agents; flip to false to act as a guest.
let canUseAgents = true;
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => canUseAgents }),
}));

function setup(agents: TWorkspaceAgent[] = AGENTS) {
  const fake = createFakeAgent({ maxMode: "ask_writes" });
  const targets: { agentId: string; workspaceSlug: string }[] = [];
  const list = vi.fn(async () => agents);
  const transports: MemoryTransport[] = [];
  store = new AgentChatStore({
    agentService: { list },
    createSession: (target) => {
      targets.push(target);
      return new AgentChatSession({
        transport: () => {
          const transport = memoryTransport(fake.app());
          transports.push(transport);
          return transport;
        },
      });
    },
  });
  return { targets, list, fake, transports };
}

function renderWidget(path = "/acme/projects/") {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <MemoryRouter initialEntries={[path]}>
        <KhaiaWidget workspaceSlug="acme" />
      </MemoryRouter>
    </SWRConfig>
  );
}

beforeEach(() => {
  localStorage.clear();
  canUseAgents = true;
});
afterEach(() => store?.closeChat());

let navigate: (to: string) => void = () => undefined;
function Navigation() {
  navigate = useNavigate();
  return null;
}

describe("chat lifecycle", () => {
  function renderWithNavigation(path: string, workspaceSlug = "acme") {
    const tree = (slug: string) => (
      <SWRConfig value={{ provider: () => new Map() }}>
        <MemoryRouter initialEntries={[path]}>
          <Navigation />
          <KhaiaWidget workspaceSlug={slug} />
        </MemoryRouter>
      </SWRConfig>
    );
    const view = render(tree(workspaceSlug));
    return {
      ...view,
      go: (to: string) => act(() => navigate(to)),
      switchTo: (slug: string) => view.rerender(tree(slug)),
    };
  }

  it("keeps the chat when the full page is left", async () => {
    setup();
    const { unmount } = render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <MemoryRouter initialEntries={["/acme/agents/"]}>
          <AgentChatRoot workspaceSlug="acme" />
        </MemoryRouter>
      </SWRConfig>
    );
    await waitFor(() => expect(store.snapshot?.status).toBe("ready"));
    const sessionId = store.snapshot?.sessionId;
    expect(sessionId).toBeTruthy();

    unmount();

    expect(store.snapshot?.status).toBe("ready");
    expect(store.snapshot?.sessionId).toBe(sessionId);
    expect(store.agentId).toBe("agent-1");
  });

  it("keeps the conversation and offers a retry or a new chat when it cannot be resumed", async () => {
    const { fake, transports } = setup();
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <MemoryRouter initialEntries={["/acme/agents/"]}>
          <AgentChatRoot workspaceSlug="acme" />
        </MemoryRouter>
      </SWRConfig>
    );
    await waitFor(() => expect(store.snapshot?.status).toBe("ready"));
    await act(() => store.sendPrompt("hello"));
    const sessionId = store.snapshot!.sessionId!;
    fake.sessions.delete(sessionId);

    act(() => transports.at(-1)!.closeWith(AgentCloseCode.sessionExpired));

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(store.snapshot?.transcript.items.length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(store.snapshot?.status).toBe("ready"));
    expect(store.snapshot?.sessionId).not.toBe(sessionId);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("closes the chat when the widget leaves its workspace", async () => {
    setup();
    await store.openChat("acme", "agent-1");
    const { unmount } = renderWidget();
    await waitFor(() => expect(store.getWorkspaceAgents("acme")).toEqual(AGENTS));
    expect(store.snapshot).not.toBeNull();

    unmount();

    expect(store.snapshot).toBeNull();
  });

  it("closes the chat when the workspace changes under the widget", async () => {
    setup();
    await store.openChat("acme", "agent-1");
    const { switchTo } = renderWithNavigation("/acme/projects/");
    await waitFor(() => expect(store.getWorkspaceAgents("acme")).toEqual(AGENTS));

    switchTo("other");

    expect(store.snapshot).toBeNull();
    expect(store.agentId).toBeNull();
  });

  it("does not flag replies already seen on the full page as new", async () => {
    setup();
    await store.openChat("acme", "agent-1");
    await store.sendPrompt("hello");
    const { go } = renderWithNavigation("/acme/agents/");
    await waitFor(() => expect(store.getWorkspaceAgents("acme")).toEqual(AGENTS));

    go("/acme/projects/");

    expect(await screen.findByRole("button", { name: OPEN })).toBeTruthy();
    expect(screen.queryByRole("button", { name: UNREAD })).toBeNull();
  });
});

describe("isAgentsPage", () => {
  it("matches the full chat page of the same workspace only", () => {
    expect(isAgentsPage("/acme/agents", "acme")).toBe(true);
    expect(isAgentsPage("/acme/agents/", "acme")).toBe(true);
    expect(isAgentsPage("/acme/agents-team/", "acme")).toBe(false);
    expect(isAgentsPage("/acme/projects/", "acme")).toBe(false);
    expect(isAgentsPage("/other/agents/", "acme")).toBe(false);
  });
});

describe("KhaiaWidget", () => {
  it("shows the bubble, and connects only once the window opens", async () => {
    const { targets } = setup();
    renderWidget();
    const bubble = await screen.findByRole("button", { name: OPEN });
    expect(targets).toEqual([]);

    await userEvent.click(bubble);
    expect(await screen.findByRole("dialog", { name: /^Chat with/ })).toBeTruthy();
    expect(screen.getByText(/^Hi, I'm/)).toBeTruthy();
    expect(targets).toEqual([{ agentId: "agent-1", workspaceSlug: "acme" }]);
  });

  it("sends a suggestion and shows the reply", async () => {
    setup();
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    const suggestion = await screen.findByRole("button", { name: "What's assigned to me?" });
    await waitFor(() => expect((suggestion as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(suggestion);
    await waitFor(() => expect(store.snapshot?.prompting).toBe(false));
    expect(screen.getAllByText(/What's assigned to me\?/).length).toBeGreaterThan(1);
  });

  it("minimizes on Escape, and flags replies that arrive while minimized", async () => {
    setup();
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    const input = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(store.canPrompt).toBe(true));
    expect(document.activeElement).toBe(input);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: OPEN }));

    await act(() => store.sendPrompt("hello"));
    expect(await screen.findByRole("button", { name: UNREAD })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: UNREAD }));
    expect(await screen.findByRole("dialog", { name: /^Chat with/ })).toBeTruthy();
    // The window takes the bubble's place, and minimizing brings the bubble back without the dot.
    expect(screen.queryByRole("button", { name: UNREAD })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(await screen.findByRole("button", { name: OPEN })).toBeTruthy();
  });

  it("switches agents from the composer picker, with agents that have no key disabled", async () => {
    const { targets } = setup();
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    await waitFor(() => expect(store.canPrompt).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /^Agent and model/ }));
    const gemini = await screen.findByRole("menuitemradio", { name: /Gemini/ });
    expect(gemini.getAttribute("aria-disabled")).toBe("true");
    expect(gemini.textContent).toContain("No API key yet");
    expect(screen.getByRole("menuitem", { name: "Manage AI providers" })).toBeTruthy();
    await userEvent.click(gemini);
    expect(store.agentId).toBe("agent-1");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    await waitFor(() => expect(store.agentId).toBe("agent-2"));
    // Picking closes the menu.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(targets.at(-1)).toEqual({ agentId: "agent-2", workspaceSlug: "acme" });
    expect(localStorage.getItem("agent_chat_last_agent:acme")).toBe("agent-2");
  });

  it("switches the model in the same chat, and the effort once the model takes one", async () => {
    const { targets } = setup();
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    await waitFor(() => expect(store.canPrompt).toBe(true));
    // The fake agent's "fast" model takes no effort, so there is no effort menu yet.
    expect(screen.queryByRole("button", { name: /^Reasoning effort/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Agent and model/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Smart" }));
    await waitFor(() => expect(store.modelConfig?.currentValue).toBe("smart"));
    expect(targets).toHaveLength(1);

    await userEvent.click(await screen.findByRole("button", { name: /^Reasoning effort/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
    await waitFor(() => expect(store.effortConfig?.currentValue).toBe("high"));
    expect(JSON.parse(localStorage.getItem("agent_chat_choices:acme:agent-1") ?? "{}")).toEqual({
      model: "smart",
      effort: "high",
    });
  });

  it("is hidden from guests, without asking the API for agents", async () => {
    canUseAgents = false;
    const { list } = setup();
    renderWidget();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: OPEN })).toBeNull();
  });

  it("locks switching while the agent answers", async () => {
    setup();
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    await waitFor(() => expect(store.canPrompt).toBe(true));
    const turn = store.sendPrompt("/sleep");
    await waitFor(() => expect(store.snapshot?.prompting).toBe(true));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "New chat" }).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /^Agent and model/ }));
    expect((await screen.findByRole("menuitemradio", { name: /Codex/ })).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Smart" }).getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard("{Escape}");
    await act(() => store.cancelTurn());
    await turn;
  });

  it("shows a plain label when there is only one agent and no model to choose", async () => {
    store = new AgentChatStore({
      agentService: { list: async () => [AGENTS[0]!] },
      createSession: () =>
        new AgentChatSession({
          transport: () => memoryTransport(createFakeAgent({ maxMode: "ask_writes", models: false }).app()),
        }),
    });
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    await waitFor(() => expect(store.canPrompt).toBe(true));
    expect(screen.queryByRole("button", { name: /^Agent and model/ })).toBeNull();
    // The header and the plain label both name the agent.
    expect(screen.getAllByText("Claude")).toHaveLength(2);
  });

  it("offers AI providers instead of a retry when the agent cannot sign in", async () => {
    const list = vi.fn(async () => AGENTS);
    store = new AgentChatStore({
      agentService: { list },
      createSession: () =>
        new AgentChatSession({
          transport: () => memoryTransport(createFakeAgent({ maxMode: "ask_writes", authRequired: true }).app()),
        }),
    });
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    expect(await screen.findByRole("button", { name: "Manage AI providers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    // The list is fetched again: the agent's key or sign-in may have gone.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("opens with a usable agent when the remembered one has no key", async () => {
    localStorage.setItem("agent_chat_last_agent:acme", "agent-3");
    const { targets } = setup();
    renderWidget();
    await userEvent.click(await screen.findByRole("button", { name: OPEN }));
    await waitFor(() => expect(targets).toEqual([{ agentId: "agent-1", workspaceSlug: "acme" }]));
  });

  it("stays hidden on the full chat page and when the workspace has no agents", async () => {
    setup();
    const { unmount } = renderWidget("/acme/agents/");
    await waitFor(() => expect(store.getWorkspaceAgents("acme")).toEqual(AGENTS));
    expect(screen.queryByRole("button", { name: OPEN })).toBeNull();
    unmount();

    setup([]);
    renderWidget();
    await waitFor(() => expect(store.getWorkspaceAgents("acme")).toEqual([]));
    expect(screen.queryByRole("button", { name: OPEN })).toBeNull();
  });
});
