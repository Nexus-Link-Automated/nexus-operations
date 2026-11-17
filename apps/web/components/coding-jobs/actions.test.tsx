/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import type { TIssue } from "@plane/types";
import { CodingJobStore } from "@/store/coding-job.store";
import { CodingMachineStore } from "@/store/coding-machine.store";
import { fakeMachineService } from "../coding-machines/test-utils";
import type { TRole } from "./test-utils";
import { fakeCodingService, makeJob, makeSettings, permissionsFor } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  machineStore: undefined as unknown,
  role: "member" as string,
  workspaceRole: "member" as string,
  issue: undefined as Partial<TIssue> | undefined,
  /** The work item's state as the project state store returns it; intake triage states are never in it. */
  state: { group: "started" } as { group: string } | undefined,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-job", () => ({ useCodingJob: () => mocks.store }));
vi.mock("@/hooks/store/use-coding-machine", () => ({
  useCodingMachine: () => mocks.machineStore,
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ issue: { getIssueById: () => mocks.issue } }),
}));
vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({ getStateById: () => mocks.state }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => permissionsFor(mocks.role as TRole, mocks.workspaceRole as TRole),
  useUser: () => ({ data: { id: "me" } }),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingJobActions } from "./actions";

const activeIssue: Partial<TIssue> = { id: "w1", state_id: "s1", archived_at: null, is_draft: false };

function setup(service = fakeCodingService()) {
  const store = new CodingJobStore({ service });
  mocks.store = store;
  mocks.machineStore = new CodingMachineStore({ service: fakeMachineService() });
  render(<CodingJobActions workspaceSlug="acme" projectId="p1" issueId="w1" />);
  return { service, store };
}

const trigger = () => screen.queryByRole("button", { name: "coding_jobs.menu.trigger" });

describe("CodingJobActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "member";
    mocks.workspaceRole = "member";
    mocks.issue = { ...activeIssue };
    mocks.state = { group: "started" };
  });

  it("shows the button to members when the project has coding jobs set up", async () => {
    const { service } = setup();
    await waitFor(() => expect(trigger()).not.toBeNull());
    expect(service.getSettings).toHaveBeenCalledWith("acme", "p1");
  });

  it("stays hidden when the project's coding jobs are not set up", async () => {
    const { store } = setup(
      fakeCodingService({ getSettings: vi.fn().mockResolvedValue(makeSettings({ configured: false })) })
    );
    await waitFor(() => expect(store.getSettings("p1")).toBeDefined());
    expect(trigger()).toBeNull();
  });

  it.each([
    ["guests", "guest", "member"],
    ["a workspace admin who is a guest in the project", "guest", "admin"],
  ])("stays hidden for %s, who cannot read the settings", async (_label, role, workspaceRole) => {
    mocks.role = role;
    mocks.workspaceRole = workspaceRole;
    const { service } = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trigger()).toBeNull();
    expect(service.getSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["drafts", { is_draft: true }, { group: "started" }],
    ["archived work items", { archived_at: "2026-11-01T00:00:00Z" }, { group: "started" }],
    ["work items flagged as waiting in intake", { is_intake: true }, { group: "started" }],
    // Pending, snoozed, rejected and duplicate intake items keep an intake (triage) state, which the project's
    // state store never holds.
    ["work items in an intake state", {}, undefined],
  ])("stays hidden on %s", async (_label, overrides, state) => {
    mocks.issue = { ...activeIssue, ...overrides };
    mocks.state = state;
    const { store } = setup();
    // Settings say configured, so only the work item keeps the button away.
    await waitFor(() => expect(store.getSettings("p1")?.configured).toBe(true));
    expect(trigger()).toBeNull();
  });

  it("starts the chosen action with the chosen agent", async () => {
    const { service } = setup(fakeCodingService({ start: vi.fn().mockResolvedValue(makeJob("j1")) }));
    await waitFor(() => expect(trigger()).not.toBeNull());

    fireEvent.click(trigger()!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "coding_jobs.actions.write_and_run_test" }));
    expect(await screen.findByText("coding_jobs.start_dialog.description.write_and_run_test")).toBeTruthy();
    // With no machines of the requester's online, the machine picker offers only Auto.
    expect(screen.getByText("coding_jobs.start_dialog.machine_auto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "coding_jobs.start_dialog.start" }));

    await waitFor(() =>
      expect(service.start).toHaveBeenCalledWith("acme", "p1", "w1", {
        action: "write_and_run_test",
        agent: "codex",
        machine: null,
      })
    );
    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith({ type: "success", title: "coding_jobs.toasts.started" })
    );
  });

  it("shows the refusal when the work item already has an active job", async () => {
    setup(
      fakeCodingService({
        start: vi.fn().mockRejectedValue(new CodingJobServiceError(409, { error: "Busy.", code: "JOB_ACTIVE" })),
      })
    );
    await waitFor(() => expect(trigger()).not.toBeNull());

    fireEvent.click(trigger()!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "coding_jobs.actions.fix_bug" }));
    fireEvent.click(await screen.findByRole("button", { name: "coding_jobs.start_dialog.start" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "coding_jobs.errors.JOB_ACTIVE");
    expect(mocks.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "coding_jobs.errors.JOB_ACTIVE" })
    );
  });

  it("keeps the dialog and its message when the start shows coding was switched off", async () => {
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce(makeSettings())
      .mockResolvedValue(makeSettings({ enabled: false, configured: false }));
    setup(
      fakeCodingService({
        getSettings,
        start: vi
          .fn()
          .mockRejectedValue(new CodingJobServiceError(400, { error: "Off.", code: "CODING_NOT_CONFIGURED" })),
      })
    );
    await waitFor(() => expect(trigger()).not.toBeNull());

    fireEvent.click(trigger()!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "coding_jobs.actions.fix_bug" }));
    fireEvent.click(await screen.findByRole("button", { name: "coding_jobs.start_dialog.start" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "coding_jobs.errors.CODING_NOT_CONFIGURED");
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(trigger()).toBeNull());
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
