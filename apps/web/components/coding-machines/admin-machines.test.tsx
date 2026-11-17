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
import { CodingMachineStore } from "@/store/coding-machine.store";
import { fakeBotService, makeBot } from "../bot-members/test-utils";
import { permissionsFor } from "../coding-jobs/test-utils";
import { fakeMachineService, makeCreated, makeMachine } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  botStore: undefined as unknown,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-machine", () => ({ useCodingMachine: () => mocks.store }));
vi.mock("@/hooks/store/use-bot-member", () => ({ useBotMember: () => mocks.botStore }));
vi.mock("@/hooks/store/user", () => ({ useUserPermissions: () => permissionsFor("member", "admin") }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingMachinesAdmin } from "./admin-machines";

const everyone = [
  makeMachine("m1", { name: "Zed box", owner: "u2", owner_display_name: "zoe" }),
  makeMachine("m2", { name: "Desk", owner: "u1", owner_display_name: "alex", is_online: false }),
  makeMachine("m3", { name: "Old", owner: "u1", owner_display_name: "alex", state: "revoked", is_online: false }),
];

function setup(
  overrides: Parameters<typeof fakeMachineService>[0] = {},
  botOverrides: Parameters<typeof fakeBotService>[0] = {}
) {
  const service = fakeMachineService({ listAll: vi.fn().mockResolvedValue(everyone), ...overrides });
  mocks.store = new CodingMachineStore({ service });
  mocks.botStore = new BotMemberStore({ service: fakeBotService(botOverrides) });
  render(<CodingMachinesAdmin workspaceSlug="acme" />);
  return service;
}

const rows = () => screen.getAllByRole("row").slice(1);
const row = (name: string) => within(rows().find((r) => r.textContent?.includes(name))!);

describe("CodingMachinesAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every machine in the workspace by owner, with state and online status", async () => {
    const service = setup();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(4));

    expect(service.listAll).toHaveBeenCalledWith("acme");
    // Sorted by owner, then oldest first.
    expect(rows().map((r) => (r.textContent?.includes("zoe") ? "zoe" : "alex"))).toEqual(["alex", "alex", "zoe"]);
    expect(row("Zed box").getByText("coding_machines.state.active")).toBeTruthy();
    expect(row("Zed box").getByText("coding_machines.online")).toBeTruthy();
    expect(row("Desk").getByText("coding_machines.offline")).toBeTruthy();
    expect(row("Old").getByText("coding_machines.state.revoked")).toBeTruthy();
    // A revoked machine cannot be revoked again.
    expect(row("Old").queryByRole("button")).toBeNull();
  });

  it("revokes a machine after confirming", async () => {
    const service = setup({
      revoke: vi.fn().mockResolvedValue({ ...everyone[0], state: "revoked" }),
    });
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(row("Zed box").getByRole("button", { name: "coding_machines.admin.revoke: Zed box" }));
    expect(await screen.findByText('coding_machines.admin.revoke_dialog.description {"owner":"zoe"}')).toBeTruthy();
    expect(service.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "coding_machines.admin.revoke_dialog.confirm" }));

    await waitFor(() => expect(service.revoke).toHaveBeenCalledWith("acme", "m1"));
    await waitFor(() => expect(row("Zed box").getByText("coding_machines.state.revoked")).toBeTruthy());
    expect(mocks.setToast).toHaveBeenCalledWith({ type: "success", title: "coding_machines.toasts.revoked" });
  });

  it("shows the refusal when revoking fails", async () => {
    setup({ revoke: vi.fn().mockRejectedValue(new CodingJobServiceError(403, { error: "No." })) });
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(row("Desk").getByRole("button", { name: "coding_machines.admin.revoke: Desk" }));
    fireEvent.click(await screen.findByRole("button", { name: "coding_machines.admin.revoke_dialog.confirm" }));

    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: "coding_jobs.errors.forbidden" })
      )
    );
  });

  it("says when no one has added a machine", async () => {
    setup({ listAll: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText("coding_machines.admin.empty")).toBeTruthy();
  });

  it("tags a bot member's machine and lets the admin approve, rename and remove it", async () => {
    const botBox = makeMachine("m9", {
      name: "Bot box",
      owner: "bot1",
      owner_display_name: "triage-bot-ab12",
      owner_is_bot: true,
      state: "awaiting_approval",
      is_online: true,
    });
    const service = setup({
      listAll: vi.fn().mockResolvedValue([...everyone, botBox]),
      approve: vi.fn().mockResolvedValue({ ...botBox, state: "active" }),
      remove: vi.fn().mockResolvedValue(undefined),
    });
    await waitFor(() => expect(rows()).toHaveLength(4));

    expect(row("Bot box").getByText("coding_machines.admin.bot")).toBeTruthy();
    expect(row("Zed box").queryByText("coding_machines.admin.bot")).toBeNull();
    // A person's machine stays theirs: the admin can only revoke it.
    expect(row("Zed box").queryByRole("button", { name: /coding_machines.actions/ })).toBeNull();
    expect(row("Bot box").getByRole("button", { name: "coding_machines.actions.rename: Bot box" })).toBeTruthy();

    fireEvent.click(row("Bot box").getByRole("button", { name: "coding_machines.actions.approve: Bot box" }));
    fireEvent.click(await screen.findByRole("button", { name: "coding_machines.approve_dialog.confirm" }));
    await waitFor(() => expect(service.approve).toHaveBeenCalledWith("acme", "m9"));
    await waitFor(() => expect(row("Bot box").getByText("coding_machines.state.active")).toBeTruthy());
    expect(row("Bot box").queryByRole("button", { name: "coding_machines.actions.approve: Bot box" })).toBeNull();

    fireEvent.click(row("Bot box").getByRole("button", { name: "coding_machines.actions.remove: Bot box" }));
    fireEvent.click(await screen.findByRole("button", { name: "coding_machines.remove_dialog.confirm" }));
    await waitFor(() => expect(service.remove).toHaveBeenCalledWith("acme", "m9"));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it("adds a machine for a bot member, sending the bot as its owner, and shows the join code once", async () => {
    const created = { ...makeCreated("m9", "Bot box"), owner: "bot1", owner_is_bot: true };
    const service = setup(
      { create: vi.fn().mockResolvedValue(created) },
      {
        list: vi
          .fn()
          .mockResolvedValue([
            makeBot("bot1", { name: "Triage" }),
            makeBot("bot2", { name: "Guesty", role: 5 }),
            makeBot("bot3", { name: "Gone", is_active: false }),
          ]),
      }
    );
    const user = userEvent.setup();
    const add = await screen.findByRole("button", { name: "coding_machines.admin.add_for_bot" });
    await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));

    await user.click(add);
    const picker = await screen.findByRole("combobox", { name: "coding_machines.add_dialog.bot" });
    await user.click(picker);
    // Only an active bot with the Member role can have a machine.
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Triage"]);
    await user.click(options[0]);
    fireEvent.change(screen.getByLabelText("coding_machines.add_dialog.name"), { target: { value: "Bot box" } });
    fireEvent.click(screen.getByRole("button", { name: "coding_machines.add_dialog.create" }));

    await waitFor(() => expect(service.create).toHaveBeenCalledWith("acme", { name: "Bot box", owner: "bot1" }));
    expect(await screen.findByText(/ABCD-EFGH-JKLM-NPQR/)).toBeTruthy();
    // The join code is shown only in the dialog; once it is closed, the bot's new machine is in the list.
    fireEvent.click(screen.getByRole("button", { name: "coding_machines.add_dialog.done" }));
    await waitFor(() => expect(screen.queryByText(/ABCD-EFGH-JKLM-NPQR/)).toBeNull());
    await waitFor(() => expect(row("Bot box").getByText("coding_machines.admin.bot")).toBeTruthy());
  });

  it("explains how to add a machine for a bot when no bot can have one", async () => {
    setup({}, { list: vi.fn().mockResolvedValue([makeBot("bot2", { role: 5 })]) });
    expect(await screen.findByText("coding_machines.admin.no_bots")).toBeTruthy();
    expect(screen.getByRole("button", { name: "coding_machines.admin.add_for_bot" }).hasAttribute("disabled")).toBe(
      true
    );
  });
});
