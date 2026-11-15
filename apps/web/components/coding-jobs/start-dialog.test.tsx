/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingMachineStore } from "@/store/coding-machine.store";
import { fakeMachineService, makeMachine } from "../coding-machines/test-utils";

const mocks = vi.hoisted(() => ({
  machineStore: undefined as unknown,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-machine", () => ({ useCodingMachine: () => mocks.machineStore }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "me" } }) }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingJobStartDialog } from "./start-dialog";

const machines = [
  makeMachine("m1", { name: "Desk" }),
  makeMachine("m2", { name: "Laptop", is_online: false }),
  makeMachine("m3", { name: "New box", state: "awaiting_approval" }),
  makeMachine("m4", { name: "Old box", state: "revoked" }),
  // The list endpoint only returns the caller's machines; one of someone else's never shows regardless.
  makeMachine("m5", { name: "Theirs", owner: "other" }),
];

function setup(list = vi.fn().mockResolvedValue(machines)) {
  const service = fakeMachineService({ list });
  mocks.machineStore = new CodingMachineStore({ service });
  const onStart = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<CodingJobStartDialog workspaceSlug="acme" action="fix_bug" onStart={onStart} onClose={onClose} />);
  return { service, onStart, onClose };
}

const machinePicker = () => screen.getByRole("combobox", { name: "coding_jobs.start_dialog.machine" });

async function openMachineOptions() {
  fireEvent.click(machinePicker());
  await screen.findAllByRole("option");
  return screen.getAllByRole("option").map((option) => option.textContent);
}

describe("CodingJobStartDialog machine picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers Auto and only the requester's own approved machines that are online", async () => {
    const { service } = setup();
    await waitFor(() => expect(service.list).toHaveBeenCalledWith("acme"));
    await waitFor(() => expect((mocks.machineStore as CodingMachineStore).getMachines("acme")).toBeDefined());

    expect(await openMachineOptions()).toEqual(["coding_jobs.start_dialog.machine_auto", "Desk"]);
  });

  it("sends the chosen machine's id", async () => {
    const { onStart } = setup();
    await waitFor(() => expect((mocks.machineStore as CodingMachineStore).getMachines("acme")).toBeDefined());

    const user = userEvent.setup();
    await user.click(machinePicker());
    await user.click(await screen.findByRole("option", { name: "Desk" }));
    await waitFor(() => expect(machinePicker().textContent).toContain("Desk"));
    fireEvent.click(screen.getByRole("button", { name: "coding_jobs.start_dialog.start" }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith("codex", "m1"));
  });

  it("sends null for Auto, and starts on Auto when the machines cannot be loaded", async () => {
    const { onStart } = setup(vi.fn().mockRejectedValue(new Error("offline")));

    expect(machinePicker().textContent).toContain("coding_jobs.start_dialog.machine_auto");
    fireEvent.click(screen.getByRole("button", { name: "coding_jobs.start_dialog.start" }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith("codex", null));
    expect(mocks.setToast).toHaveBeenCalledWith({ type: "success", title: "coding_jobs.toasts.started" });
  });
});
