/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import { CodingMachineStore } from "@/store/coding-machine.store";
import { permissionsFor } from "../coding-jobs/test-utils";
import { fakeMachineService, makeMachine } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-machine", () => ({ useCodingMachine: () => mocks.store }));
vi.mock("@/hooks/store/user", () => ({ useUserPermissions: () => permissionsFor("member", "admin") }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingMachinesAdmin } from "./admin-machines";

const everyone = [
  makeMachine("m1", { name: "Zed box", owner: "u2", owner_display_name: "zoe" }),
  makeMachine("m2", { name: "Desk", owner: "u1", owner_display_name: "alex", is_online: false }),
  makeMachine("m3", { name: "Old", owner: "u1", owner_display_name: "alex", state: "revoked", is_online: false }),
];

function setup(overrides: Parameters<typeof fakeMachineService>[0] = {}) {
  const service = fakeMachineService({ listAll: vi.fn().mockResolvedValue(everyone), ...overrides });
  mocks.store = new CodingMachineStore({ service });
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
});
