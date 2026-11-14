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
import type { TRole } from "./test-utils";
import { allowPermissionsFor, fakeCodingService, makeJob, makeSettings } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  role: "member" as string,
  issue: undefined as Partial<TIssue> | undefined,
  stateGroup: "started" as string,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-job", () => ({ useCodingJob: () => mocks.store }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ issue: { getIssueById: () => mocks.issue } }),
}));
vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({ getStateById: () => ({ group: mocks.stateGroup }) }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({
    allowPermissions: (...args: Parameters<ReturnType<typeof allowPermissionsFor>>) =>
      allowPermissionsFor(mocks.role as TRole)(...args),
  }),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingJobActions } from "./actions";

const activeIssue: Partial<TIssue> = { id: "w1", state_id: "s1", archived_at: null, is_draft: false };

function setup(service = fakeCodingService()) {
  mocks.store = new CodingJobStore({ service });
  render(<CodingJobActions workspaceSlug="acme" projectId="p1" issueId="w1" />);
  return service;
}

const trigger = () => screen.queryByRole("button", { name: "coding_jobs.menu.trigger" });

describe("CodingJobActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "member";
    mocks.issue = { ...activeIssue };
    mocks.stateGroup = "started";
  });

  it("shows the button to members when the project has coding jobs set up", async () => {
    const service = setup();
    await waitFor(() => expect(trigger()).not.toBeNull());
    expect(service.getSettings).toHaveBeenCalledWith("acme", "p1");
  });

  it("stays hidden when the project's coding jobs are not set up", async () => {
    const service = setup(
      fakeCodingService({ getSettings: vi.fn().mockResolvedValue(makeSettings({ configured: false })) })
    );
    await waitFor(() => expect(service.getSettings).toHaveBeenCalled());
    expect(trigger()).toBeNull();
  });

  it("stays hidden for guests, who cannot read the settings", async () => {
    mocks.role = "guest";
    const service = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trigger()).toBeNull();
    expect(service.getSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["drafts", { is_draft: true }, "started"],
    ["archived work items", { archived_at: "2026-11-01T00:00:00Z" }, "started"],
    ["work items waiting in intake", { is_intake: true }, "started"],
    ["work items in the intake (triage) state", {}, "triage"],
  ])("stays hidden on %s", async (_label, overrides, stateGroup) => {
    mocks.issue = { ...activeIssue, ...overrides };
    mocks.stateGroup = stateGroup;
    const service = setup();
    await waitFor(() => expect(service.getSettings).toHaveBeenCalled());
    expect(trigger()).toBeNull();
  });

  it("starts the chosen action with the chosen agent", async () => {
    const service = setup(fakeCodingService({ start: vi.fn().mockResolvedValue(makeJob("j1")) }));
    await waitFor(() => expect(trigger()).not.toBeNull());

    fireEvent.click(trigger()!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "coding_jobs.actions.write_and_run_test" }));
    expect(await screen.findByText("coding_jobs.start_dialog.description.write_and_run_test")).toBeTruthy();
    // The machine picker offers only Auto until machines can be registered.
    expect(screen.getByText("coding_jobs.start_dialog.machine_auto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "coding_jobs.start_dialog.start" }));

    await waitFor(() =>
      expect(service.start).toHaveBeenCalledWith("acme", "p1", "w1", { action: "write_and_run_test", agent: "codex" })
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
});
