/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import { CodingMachineStore } from "@/store/coding-machine.store";
import type { TRole } from "../coding-jobs/test-utils";
import { permissionsFor } from "../coding-jobs/test-utils";
import { fakeMachineService, makeCreated, makeMachine } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  workspaceRole: "member" as string,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-machine", () => ({ useCodingMachine: () => mocks.store }));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => permissionsFor("member", mocks.workspaceRole as TRole),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingMachinesSettings } from "./machines-settings";

function setup(overrides: Parameters<typeof fakeMachineService>[0] = {}) {
  const service = fakeMachineService(overrides);
  mocks.store = new CodingMachineStore({ service });
  render(<CodingMachinesSettings workspaceSlug="acme" workspaceName="Acme" />);
  return service;
}

const items = () => screen.queryAllByTestId("coding-machine");
const item = (name: string) => within(items().find((li) => li.textContent?.includes(name))!);
const button = (name: string) => screen.getByRole("button", { name });

describe("CodingMachinesSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRole = "member";
  });

  it("lists the user's machines with their state, status and report, naming the workspace", async () => {
    const service = setup({
      list: vi
        .fn()
        .mockResolvedValue([
          makeMachine("m1", { name: "Desk" }),
          makeMachine("m2", { name: "Laptop", is_online: false, last_seen_at: "2026-11-14T08:00:00Z" }),
        ]),
    });

    await waitFor(() => expect(items()).toHaveLength(2));
    expect(service.list).toHaveBeenCalledWith("acme");
    expect(screen.getByText('coding_machines.description {"workspace":"Acme"}')).toBeTruthy();

    const desk = item("Desk");
    expect(desk.getByText("coding_machines.state.active")).toBeTruthy();
    expect(desk.getByText("coding_machines.online")).toBeTruthy();
    expect(desk.getByText("host-m1 · linux · v0.1.0")).toBeTruthy();
    expect(
      desk.getByText(
        "coding_jobs.agents.codex 0.47.0: coding_machines.agent_signed_in · coding_jobs.agents.claude: coding_machines.agent_not_signed_in"
      )
    ).toBeTruthy();
    expect(desk.getByText("coding_machines.docker_available 28.1.1")).toBeTruthy();
    expect(desk.getByText('coding_machines.slots_value {"free":1,"total":2}')).toBeTruthy();

    const laptop = item("Laptop");
    expect(laptop.getByText("coding_machines.offline")).toBeTruthy();
    expect(laptop.getByText(/^coding_machines\.last_seen /)).toBeTruthy();
  });

  it("shows the join command and code once when a machine is added", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const service = setup({ create: vi.fn().mockResolvedValue(makeCreated("m9", "Work laptop")) });
    await screen.findByText("coding_machines.empty");

    fireEvent.click(button("coding_machines.add"));
    fireEvent.change(await screen.findByLabelText("coding_machines.add_dialog.name"), {
      target: { value: "  Work laptop " },
    });
    fireEvent.click(button("coding_machines.add_dialog.create"));

    await waitFor(() => expect(service.create).toHaveBeenCalledWith("acme", { name: "Work laptop" }));
    const command = `nexus-machine join ${window.location.origin} ABCD-EFGH-JKLM-NPQR`;
    expect(await screen.findByText(command)).toBeTruthy();
    expect(screen.getByText("systemctl --user enable --now nexus-machine")).toBeTruthy();
    expect(screen.getByText(/^coding_machines\.add_dialog\.expires /)).toBeTruthy();

    fireEvent.click(button("coding_machines.add_dialog.copy: coding_machines.add_dialog.step_join"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));

    // The new machine is listed, without its code; closing the dialog drops the code for good.
    expect(item("Work laptop").getByText("coding_machines.state.pending")).toBeTruthy();
    fireEvent.click(button("coding_machines.add_dialog.done"));
    await waitFor(() => expect(screen.queryByText(command)).toBeNull());
    expect(screen.queryByText(/ABCD-EFGH-JKLM-NPQR/)).toBeNull();

    fireEvent.click(button("coding_machines.add"));
    expect(await screen.findByLabelText("coding_machines.add_dialog.name")).toHaveProperty("value", "");
    expect(screen.queryByText(/ABCD-EFGH-JKLM-NPQR/)).toBeNull();
  });

  it("shows the refusal when the user has too many machines", async () => {
    setup({
      create: vi.fn().mockRejectedValue(new CodingJobServiceError(409, { error: "Limit.", code: "MACHINE_LIMIT" })),
    });
    await screen.findByText("coding_machines.empty");

    fireEvent.click(button("coding_machines.add"));
    fireEvent.change(await screen.findByLabelText("coding_machines.add_dialog.name"), {
      target: { value: "One more" },
    });
    fireEvent.click(button("coding_machines.add_dialog.create"));

    expect(await screen.findByText("coding_jobs.errors.MACHINE_LIMIT")).toBeTruthy();
    expect(screen.queryByText(/nexus-machine join/)).toBeNull();
  });

  it("approves a machine that joined, showing the hostname it reported", async () => {
    const waiting = makeMachine("m1", { name: "Desk", state: "awaiting_approval", hostname: "desk-01", os: "linux" });
    const service = setup({
      list: vi.fn().mockResolvedValue([waiting]),
      approve: vi.fn().mockResolvedValue({ ...waiting, state: "active" }),
    });
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(item("Desk").getByText('coding_machines.awaiting_hint {"hostname":"desk-01"}')).toBeTruthy();

    fireEvent.click(button("coding_machines.actions.approve"));
    expect(
      await screen.findByText('coding_machines.approve_dialog.description {"hostname":"desk-01","os":"linux"}')
    ).toBeTruthy();
    fireEvent.click(button("coding_machines.approve_dialog.confirm"));

    await waitFor(() => expect(service.approve).toHaveBeenCalledWith("acme", "m1"));
    await waitFor(() => expect(item("Desk").getByText("coding_machines.state.active")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "coding_machines.actions.approve" })).toBeNull();
  });

  it("renames a machine", async () => {
    const service = setup({
      list: vi.fn().mockResolvedValue([makeMachine("m1", { name: "Desk" })]),
      rename: vi.fn().mockResolvedValue(makeMachine("m1", { name: "Office desk" })),
    });
    await waitFor(() => expect(items()).toHaveLength(1));

    fireEvent.click(button("coding_machines.actions.rename"));
    const input = await screen.findByLabelText("coding_machines.add_dialog.name");
    expect(input).toHaveProperty("value", "Desk");
    fireEvent.change(input, { target: { value: "Office desk" } });
    fireEvent.click(button("coding_machines.rename_dialog.save"));

    await waitFor(() => expect(service.rename).toHaveBeenCalledWith("acme", "m1", { name: "Office desk" }));
    await waitFor(() => expect(item("Office desk")).toBeTruthy());
  });

  it("removes a machine after confirming", async () => {
    const service = setup({ list: vi.fn().mockResolvedValue([makeMachine("m1", { name: "Desk" })]) });
    await waitFor(() => expect(items()).toHaveLength(1));

    fireEvent.click(button("coding_machines.actions.remove"));
    expect(await screen.findByText("coding_machines.remove_dialog.description")).toBeTruthy();
    expect(service.remove).not.toHaveBeenCalled();
    fireEvent.click(button("coding_machines.remove_dialog.confirm"));

    await waitFor(() => expect(service.remove).toHaveBeenCalledWith("acme", "m1"));
    await waitFor(() => expect(items()).toHaveLength(0));
    expect(screen.getByText("coding_machines.empty")).toBeTruthy();
  });

  it("says when a pending machine's join code expired, leaving only Remove", async () => {
    setup({
      list: vi.fn().mockResolvedValue([
        makeMachine("m1", {
          name: "Old",
          state: "pending",
          is_online: false,
          join_code_expires_at: "2026-11-14T08:30:00Z",
          join_code_expired: true,
        }),
        makeMachine("m2", {
          name: "New",
          state: "pending",
          is_online: false,
          join_code_expires_at: "2026-11-14T10:30:00Z",
        }),
      ]),
    });
    await waitFor(() => expect(items()).toHaveLength(2));

    const old = item("Old");
    expect(old.getByText("coding_machines.pending_expired")).toBeTruthy();
    expect(old.queryByRole("button", { name: "coding_machines.actions.rename" })).toBeNull();
    expect(old.getByRole("button", { name: "coding_machines.actions.remove" })).toBeTruthy();
    expect(item("New").getByText(/^coding_machines\.pending_hint /)).toBeTruthy();
  });

  it("tells guests machines are not for them, without asking the API", async () => {
    mocks.workspaceRole = "guest";
    const service = setup();

    expect(await screen.findByText("coding_machines.guest")).toBeTruthy();
    expect(service.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "coding_machines.add" })).toBeNull();
  });

  it("shows the guest message when the API refuses with 403", async () => {
    mocks.workspaceRole = "none";
    setup({ list: vi.fn().mockRejectedValue(new CodingJobServiceError(403, { error: "Guests cannot." })) });

    expect(await screen.findByText("coding_machines.guest")).toBeTruthy();
  });

  it("reloads the list every 15 seconds so online status stays current", async () => {
    vi.useFakeTimers();
    try {
      const service = setup({ list: vi.fn().mockResolvedValue([makeMachine("m1")]) });
      expect(service.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(service.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
