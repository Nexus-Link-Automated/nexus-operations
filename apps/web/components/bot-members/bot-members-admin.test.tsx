/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import { BotMemberStore } from "@/store/bot-member.store";
import { fakeBotService, makeBot } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  setToast: vi.fn(),
  copy: vi.fn(),
  fetchWorkspaceMembers: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@plane/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/utils")>()),
  copyTextToClipboard: mocks.copy,
}));
vi.mock("@/hooks/store/use-bot-member", () => ({ useBotMember: () => mocks.store }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ workspace: { fetchWorkspaceMembers: mocks.fetchWorkspaceMembers } }),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { BotMembersAdmin } from "./bot-members-admin";

const triage = makeBot("b1", {
  name: "Triage",
  description: "Sorts <b>new</b> bug reports",
  token_last_used: "2026-11-14T09:30:00Z",
});
const reviewer = makeBot("b2", { name: "Reviewer", role: 5 });
const gone = makeBot("b3", { name: "Gone", is_active: false, role: null, token_created_at: null });

function setup(overrides: Parameters<typeof fakeBotService>[0] = {}) {
  const service = fakeBotService({ list: vi.fn().mockResolvedValue([triage, reviewer, gone]), ...overrides });
  mocks.store = new BotMemberStore({ service });
  render(<BotMembersAdmin workspaceSlug="acme" />);
  return service;
}

const rows = () => screen.getAllByRole("row").slice(1);
const row = (name: string) => within(rows().find((r) => r.textContent?.includes(name))!);

describe("BotMembersAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.copy.mockResolvedValue(undefined);
  });

  it("lists the bots with role, status, what they are for and when their token was last used", async () => {
    const service = setup();
    await waitFor(() => expect(rows()).toHaveLength(3));

    expect(service.list).toHaveBeenCalledWith("acme");
    // Active bots first, by name; removed ones last.
    expect(rows().map((r) => r.textContent?.match(/Gone|Reviewer|Triage/)?.[0])).toEqual([
      "Reviewer",
      "Triage",
      "Gone",
    ]);
    expect(row("Triage").getByText("bot_members.role.member")).toBeTruthy();
    expect(row("Triage").getByText("bot_members.status.active")).toBeTruthy();
    const description = row("Triage").getByText("Sorts <b>new</b> bug reports");
    expect(description.querySelector("b")).toBeNull();
    expect(row("Triage").getByRole("time")).toBeTruthy();
    expect(row("Reviewer").getByText("bot_members.role.guest")).toBeTruthy();
    expect(row("Reviewer").getByText("bot_members.never_used")).toBeTruthy();
    expect(row("Gone").getByText("bot_members.status.removed")).toBeTruthy();
    expect(row("Gone").getByText("bot_members.no_token")).toBeTruthy();
    // A removed bot can't be changed.
    expect(row("Gone").queryByRole("button")).toBeNull();
  });

  it("creates a bot and shows its token once, in a copyable field", async () => {
    const service = setup({
      create: vi.fn().mockResolvedValue({ ...makeBot("b4", { name: "Docs bot", role: 5 }), token: "plane_api_secret" }),
    });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "bot_members.add" }));
    const create = screen.getByRole("button", { name: "bot_members.form.create" });
    expect(create.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("bot_members.form.name"), { target: { value: " Docs bot " } });
    fireEvent.change(screen.getByLabelText("bot_members.form.description"), { target: { value: "Writes docs" } });
    await user.click(screen.getByRole("combobox", { name: "bot_members.form.role" }));
    await user.click(await screen.findByRole("option", { name: "bot_members.role.guest" }));
    await user.click(create);

    await waitFor(() =>
      expect(service.create).toHaveBeenCalledWith("acme", { name: "Docs bot", role: 5, description: "Writes docs" })
    );
    const token = (await screen.findByTestId("bot-token")) as HTMLInputElement;
    expect(token.value).toBe("plane_api_secret");
    expect(token.readOnly).toBe(true);
    expect(screen.getByText("bot_members.token_dialog.description")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "bot_members.token_dialog.copy" }));
    expect(mocks.copy).toHaveBeenCalledWith("plane_api_secret");

    // Once closed, the token is gone for good: the list only shows the bot.
    fireEvent.click(screen.getByRole("button", { name: "bot_members.token_dialog.done" }));
    await waitFor(() => expect(screen.queryByTestId("bot-token")).toBeNull());
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(screen.queryByText("plane_api_secret")).toBeNull();
    expect(screen.queryByDisplayValue("plane_api_secret")).toBeNull();
  });

  it("shows the refusal when the workspace has the most bots allowed", async () => {
    setup({
      create: vi.fn().mockRejectedValue(new CodingJobServiceError(409, { error: "At most 20.", code: "BOT_LIMIT" })),
    });
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(screen.getByRole("button", { name: "bot_members.add" }));
    fireEvent.change(screen.getByLabelText("bot_members.form.name"), { target: { value: "One more" } });
    fireEvent.click(screen.getByRole("button", { name: "bot_members.form.create" }));

    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith({
        type: "error",
        title: "bot_members.toasts.create_failed",
        message: "coding_jobs.errors.BOT_LIMIT",
      })
    );
    expect(screen.queryByTestId("bot-token")).toBeNull();
  });

  it("saves only what changed when a bot is edited", async () => {
    const service = setup({ update: vi.fn().mockResolvedValue({ ...triage, name: "Triage 2" }) });
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(row("Triage").getByRole("button", { name: "bot_members.actions.edit: Triage" }));
    fireEvent.change(screen.getByLabelText("bot_members.form.name"), { target: { value: "Triage 2" } });
    fireEvent.click(screen.getByRole("button", { name: "bot_members.form.save" }));

    await waitFor(() => expect(service.update).toHaveBeenCalledWith("acme", "b1", { name: "Triage 2" }));
    await waitFor(() => expect(row("Triage 2")).toBeTruthy());
  });

  it("gives a bot a new token after confirming and shows it once", async () => {
    const service = setup({ rotateToken: vi.fn().mockResolvedValue({ ...triage, token: "plane_api_new" }) });
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(row("Triage").getByRole("button", { name: "bot_members.actions.new_token: Triage" }));
    expect(await screen.findByText("bot_members.new_token_dialog.description")).toBeTruthy();
    expect(service.rotateToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "bot_members.new_token_dialog.confirm" }));

    await waitFor(() => expect(service.rotateToken).toHaveBeenCalledWith("acme", "b1"));
    expect(((await screen.findByTestId("bot-token")) as HTMLInputElement).value).toBe("plane_api_new");
  });

  it("removes a bot after confirming and shows it as removed", async () => {
    const service = setup();
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(row("Triage").getByRole("button", { name: "bot_members.actions.remove: Triage" }));
    expect(await screen.findByText('bot_members.remove_dialog.title {"name":"Triage"}')).toBeTruthy();
    expect(service.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "bot_members.remove_dialog.confirm" }));

    await waitFor(() => expect(service.remove).toHaveBeenCalledWith("acme", "b1"));
    await waitFor(() => expect(row("Triage").getByText("bot_members.status.removed")).toBeTruthy());
    expect(row("Triage").queryByRole("button")).toBeNull();
    expect(mocks.setToast).toHaveBeenCalledWith({ type: "success", title: "bot_members.toasts.removed" });
    // The members list and pickers drop it at once.
    expect(mocks.fetchWorkspaceMembers).toHaveBeenCalledWith("acme");
  });

  it("says when there are no bot members", async () => {
    setup({ list: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText("bot_members.empty")).toBeTruthy();
  });

  it("says when the bot members could not be loaded", async () => {
    setup({ list: vi.fn().mockRejectedValue(new CodingJobServiceError(500, {})) });
    expect(await screen.findByText("bot_members.load_failed")).toBeTruthy();
  });
});
