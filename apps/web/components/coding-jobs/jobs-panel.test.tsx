/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import type { TCodingJob } from "@plane/types";
import { CodingJobStore } from "@/store/coding-job.store";
import type { TRole } from "./test-utils";
import { fakeCodingService, makeJob, makeSettings, permissionsFor } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  role: "member" as string,
  workspaceRole: "member" as string,
  state: { group: "started" } as { group: string } | undefined,
  archivedAt: null as string | null,
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-job", () => ({ useCodingJob: () => mocks.store }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ getUserDetails: (id: string) => ({ id, display_name: id === "me" ? "Me" : "Other" }) }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: {
      getIssueById: () => ({ id: "w1", state_id: "s1", archived_at: mocks.archivedAt, is_draft: false }),
    },
  }),
}));
vi.mock("@/hooks/store/use-project-state", () => ({ useProjectState: () => ({ getStateById: () => mocks.state }) }));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "me" } }),
  useUserPermissions: () => permissionsFor(mocks.role as TRole, mocks.workspaceRole as TRole),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingJobsPanel } from "./jobs-panel";

async function setup(jobs: TCodingJob[], overrides: Parameters<typeof fakeCodingService>[0] = {}) {
  const service = fakeCodingService({ list: vi.fn().mockResolvedValue(jobs), ...overrides });
  mocks.store = new CodingJobStore({ service });
  render(<CodingJobsPanel workspaceSlug="acme" projectId="p1" issueId="w1" />);
  if (jobs.length > 0) await screen.findAllByTestId("coding-job");
  if (mocks.role === "admin" || mocks.role === "member")
    await waitFor(() => expect(service.getSettings).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  return service;
}

const row = (index = 0) => within(screen.getAllByTestId("coding-job")[index]);
const button = (name: string, index = 0) => row(index).queryByRole("button", { name });

const failed = makeJob("j1", {
  status: "finished",
  outcome: "job_error",
  is_active: false,
  is_retryable: true,
  error_reason: "Machine offline",
  finished_at: "2026-11-14T10:10:00Z",
});

describe("CodingJobsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "member";
    mocks.workspaceRole = "member";
    mocks.state = { group: "started" };
    mocks.archivedAt = null;
  });

  it("shows status, requester, PR link and error reason", async () => {
    await setup([
      makeJob("j2", {
        status: "finished",
        outcome: "fixed",
        is_active: false,
        pr_url: "https://github.com/acme/app/pull/7",
        requested_by: "other",
        created_at: "2026-11-14T11:00:00Z",
      }),
      failed,
    ]);

    expect(row(0).getByText("coding_jobs.outcome.fixed")).toBeTruthy();
    expect(row(0).getByText(/coding_jobs.panel.requested_by .*Other/)).toBeTruthy();
    expect(row(0).getByRole("link", { name: "coding_jobs.panel.pr" }).getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7"
    );
    expect(row(1).getByText("Machine offline")).toBeTruthy();
    expect(row(1).getByText("coding_jobs.outcome.job_error")).toBeTruthy();
  });

  it("lets the person who started an active job cancel it, but not retry it", async () => {
    await setup([makeJob("j1", { requested_by: "me" })]);
    expect(button("coding_jobs.panel.cancel")).not.toBeNull();
    expect(button("coding_jobs.panel.retry")).toBeNull();
  });

  it("hides Cancel from another member", async () => {
    await setup([makeJob("j1", { requested_by: "other" })]);
    expect(button("coding_jobs.panel.cancel")).toBeNull();
  });

  it.each([
    ["project", "admin", "member"],
    ["workspace", "member", "admin"],
  ])("shows Cancel to a %s admin for anyone's job", async (_label, role, workspaceRole) => {
    mocks.role = role;
    mocks.workspaceRole = workspaceRole;
    await setup([makeJob("j1", { requested_by: "other" })]);
    expect(button("coding_jobs.panel.cancel")).not.toBeNull();
  });

  it("gives a workspace admin who is a guest in the project no buttons, as the API refuses them", async () => {
    mocks.role = "guest";
    mocks.workspaceRole = "admin";
    await setup([makeJob("j2", { requested_by: "other", created_at: "2026-11-14T11:00:00Z" }), failed]);
    expect(screen.queryAllByRole("button", { name: /coding_jobs.panel.(cancel|retry)/ })).toHaveLength(0);
  });

  it.each([
    ["the work item is archived", () => (mocks.archivedAt = "2026-11-01T00:00:00Z"), {}],
    [
      "coding jobs are switched off",
      () => undefined,
      { getSettings: vi.fn().mockResolvedValue(makeSettings({ configured: false })) },
    ],
  ])("hides Retry when %s, where the API would refuse it", async (_label, arrange, overrides) => {
    arrange();
    await setup([failed], overrides);
    expect(button("coding_jobs.panel.retry")).toBeNull();
  });

  it("shows Retry only on a retryable job, and no Cancel once it ended", async () => {
    await setup([
      makeJob("j2", { status: "finished", outcome: "bug_found", is_active: false, created_at: "2026-11-14T11:00:00Z" }),
      failed,
    ]);
    expect(button("coding_jobs.panel.retry", 0)).toBeNull();
    expect(button("coding_jobs.panel.retry", 1)).not.toBeNull();
    expect(button("coding_jobs.panel.cancel", 1)).toBeNull();
  });

  it("shows guests the jobs without any buttons", async () => {
    mocks.role = "guest";
    await setup([makeJob("j2", { requested_by: "me", created_at: "2026-11-14T11:00:00Z" }), failed]);
    expect(screen.queryAllByRole("button", { name: /coding_jobs.panel.(cancel|retry)/ })).toHaveLength(0);
  });

  it("cancels a job and shows it as cancelled", async () => {
    const service = await setup([makeJob("j1")], {
      cancel: vi.fn().mockResolvedValue(
        makeJob("j1", {
          status: "cancelled",
          outcome: "job_error",
          is_active: false,
          is_retryable: true,
          updated_at: "2026-11-14T10:05:00Z",
        })
      ),
    });

    fireEvent.click(button("coding_jobs.panel.cancel")!);

    await waitFor(() => expect(service.cancel).toHaveBeenCalledWith("acme", "p1", "w1", "j1"));
    expect(await row().findByText("coding_jobs.status.cancelled")).toBeTruthy();
    expect(button("coding_jobs.panel.retry")).not.toBeNull();
  });

  it("shows the refusal when the job already ended", async () => {
    await setup([makeJob("j1")], {
      cancel: vi.fn().mockRejectedValue(new CodingJobServiceError(409, { error: "Ended.", code: "JOB_NOT_ACTIVE" })),
    });

    fireEvent.click(button("coding_jobs.panel.cancel")!);

    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith({
        type: "error",
        title: "coding_jobs.toasts.cancel_failed",
        message: "coding_jobs.errors.JOB_NOT_ACTIVE",
      })
    );
  });

  it("retries a job: the new job appears above it", async () => {
    const service = await setup([failed], {
      retry: vi.fn().mockResolvedValue(makeJob("j2", { retry_of: "j1", created_at: "2026-11-14T12:00:00Z" })),
    });

    fireEvent.click(button("coding_jobs.panel.retry")!);

    await waitFor(() => expect(service.retry).toHaveBeenCalledWith("acme", "p1", "w1", "j1"));
    await waitFor(() => expect(screen.getAllByTestId("coding-job")).toHaveLength(2));
    expect(row(0).getByText("coding_jobs.status.queued")).toBeTruthy();
  });

  it("shows the refusal when the job cannot be retried", async () => {
    await setup([failed], {
      retry: vi.fn().mockRejectedValue(new CodingJobServiceError(409, { error: "No.", code: "JOB_NOT_RETRYABLE" })),
    });

    fireEvent.click(button("coding_jobs.panel.retry")!);

    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: "coding_jobs.errors.JOB_NOT_RETRYABLE" })
      )
    );
  });

  it("shows the empty panel to members where jobs can be started", async () => {
    const service = await setup([]);
    await waitFor(() => expect(service.list).toHaveBeenCalled());
    expect(await screen.findByText("coding_jobs.panel.empty")).toBeTruthy();
  });

  it("renders nothing for a work item with no jobs in a project without coding jobs", async () => {
    const service = await setup([], {
      getSettings: vi.fn().mockResolvedValue(makeSettings({ enabled: false, configured: false })),
    });
    await waitFor(() => expect(service.list).toHaveBeenCalled());
    expect(screen.queryByText("coding_jobs.panel.title")).toBeNull();
  });

  it("shows the machine a job ran on, and that a queued job is waiting for one", async () => {
    await setup([
      makeJob("j3", { created_at: "2026-11-14T12:00:00Z" }),
      makeJob("j2", {
        status: "running",
        ran_on: "m1",
        ran_on_name: "Laptop",
        progress: "Running the tests",
        started_at: "2026-11-14T11:01:00Z",
        created_at: "2026-11-14T11:00:00Z",
      }),
      makeJob("j1", {
        status: "finished",
        outcome: "fixed",
        is_active: false,
        ran_on: null,
        ran_on_name: "Old desktop",
        progress: "Opened the pull request",
      }),
    ]);

    expect(row(0).getByText("coding_jobs.panel.waiting_for_machine")).toBeTruthy();
    expect(row(0).queryByText(/coding_jobs.panel.ran_on/)).toBeNull();
    expect(row(0).queryByRole("button", { name: "coding_jobs.panel.progress" })).toBeNull();

    expect(row(1).getByText(/coding_jobs.panel.ran_on .*Laptop/)).toBeTruthy();
    expect(row(1).getByText(/coding_jobs.panel.started/)).toBeTruthy();
    expect(row(1).getByTestId("coding-job-progress-line").textContent).toBe("Running the tests");
    expect(row(1).queryByText("coding_jobs.panel.waiting_for_machine")).toBeNull();

    expect(row(2).getByText(/coding_jobs.panel.ran_on .*Old desktop/)).toBeTruthy();
    expect(row(2).queryByTestId("coding-job-progress-line")).toBeNull();
  });

  it("shows the latest progress line as text, never as markup", async () => {
    await setup([makeJob("j1", { status: "running", ran_on_name: "Laptop", progress: "<b>Editing</b> app.py" })]);

    expect(row().getByTestId("coding-job-progress-line").textContent).toBe("<b>Editing</b> app.py");
    expect(row().getByTestId("coding-job-progress-line").querySelector("b")).toBeNull();
  });

  it("loads a job's progress lines when opened and shows them as plain text", async () => {
    const service = await setup(
      [makeJob("j1", { status: "running", ran_on_name: "Laptop", started_at: "2026-11-14T10:01:00Z" })],
      {
        listEvents: vi.fn().mockResolvedValue({
          results: [
            { seq: 1, kind: "status", text: "Started", created_at: "2026-11-14T10:01:00Z" },
            {
              seq: 2,
              kind: "tool",
              text: "<img src=x onerror=alert(1)>\npytest -q",
              created_at: "2026-11-14T10:02:00Z",
            },
          ],
          has_more: false,
        }),
      }
    );
    const toggle = row().getByRole("button", { name: "coding_jobs.panel.progress" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(service.listEvents).not.toHaveBeenCalled();

    fireEvent.click(toggle);

    const events = await row().findAllByTestId("coding-job-event");
    expect(service.listEvents).toHaveBeenCalledWith("acme", "p1", "w1", "j1", undefined);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(events).toHaveLength(2);
    expect(within(events[1]).getByText("coding_jobs.event_kind.tool")).toBeTruthy();
    expect(events[1].textContent).toContain("<img src=x onerror=alert(1)>\npytest -q");
    expect(events[1].querySelector("img")).toBeNull();

    fireEvent.click(toggle);
    expect(row().queryAllByTestId("coding-job-event")).toHaveLength(0);
  });

  it("says so when a job has no progress lines, or they could not be loaded", async () => {
    await setup(
      [
        makeJob("j2", { status: "cancelled", is_active: false, created_at: "2026-11-14T11:00:00Z" }),
        makeJob("j1", { status: "finished", outcome: "job_error", is_active: false }),
      ],
      {
        listEvents: vi
          .fn()
          .mockImplementation((_w, _p, _i, jobId: string) =>
            jobId === "j2"
              ? Promise.resolve({ results: [], has_more: false })
              : Promise.reject(new CodingJobServiceError(500, {}))
          ),
      }
    );

    fireEvent.click(row(0).getByRole("button", { name: "coding_jobs.panel.progress" }));
    fireEvent.click(row(1).getByRole("button", { name: "coding_jobs.panel.progress" }));

    expect(await row(0).findByText("coding_jobs.panel.progress_empty")).toBeTruthy();
    expect(await row(1).findByText("coding_jobs.panel.progress_load_failed")).toBeTruthy();
  });

  it("follows the work item's jobs while shown and stops when it goes away", async () => {
    const store = new CodingJobStore({ service: fakeCodingService({ list: vi.fn().mockResolvedValue([]) }) });
    const stop = vi.fn();
    const watchJobs = vi.spyOn(store, "watchJobs").mockReturnValue(stop);
    mocks.store = store;

    const { unmount } = render(<CodingJobsPanel workspaceSlug="acme" projectId="p1" issueId="w1" />);
    await waitFor(() => expect(watchJobs).toHaveBeenCalledWith("acme", "p1", "w1"));
    expect(stop).not.toHaveBeenCalled();

    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
