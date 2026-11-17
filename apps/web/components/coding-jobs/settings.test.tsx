/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import { CodingJobStore } from "@/store/coding-job.store";
import type { TRole } from "./test-utils";
import { fakeCodingService, makeRepository, makeSettings, permissionsFor } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  role: "admin" as string,
  workspaceRole: "member" as string,
  createState: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-coding-job", () => ({ useCodingJob: () => mocks.store }));
vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({
    getProjectStates: () => [
      { id: "s-ready", name: "Ready" },
      { id: "s-review", name: "In review" },
      { id: "s-todo", name: "Todo" },
    ],
    fetchProjectStates: vi.fn(),
    createState: mocks.createState,
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => permissionsFor(mocks.role as TRole, mocks.workspaceRole as TRole),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { CodingJobsSettings } from "./settings";

async function setup(overrides: Parameters<typeof fakeCodingService>[0] = {}) {
  const service = fakeCodingService(overrides);
  mocks.store = new CodingJobStore({ service });
  render(<CodingJobsSettings workspaceSlug="acme" projectId="p1" />);
  await screen.findByLabelText("coding_jobs.settings.repo_url");
  return service;
}

const repoInput = () => screen.getByLabelText("coding_jobs.settings.repo_url") as HTMLInputElement;
const saveButton = () => screen.queryByRole("button", { name: "coding_jobs.settings.save" });
const createFailedButton = () => screen.queryByRole("button", { name: "coding_jobs.settings.create_failed" });

describe("CodingJobsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "admin";
    mocks.workspaceRole = "member";
  });

  it("shows what each column resolves to now", async () => {
    await setup();
    expect(screen.getByText('coding_jobs.settings.resolves_to_by_name {"state":"Ready"}')).toBeTruthy();
    expect(screen.getByText("coding_jobs.settings.resolves_none")).toBeTruthy();
  });

  it("lets a project admin edit and saves only what changed", async () => {
    const service = await setup({
      updateSettings: vi.fn().mockResolvedValue(makeSettings({ repo_url: "https://github.com/acme/other" })),
    });
    expect(repoInput().disabled).toBe(false);
    expect(saveButton()?.hasAttribute("disabled")).toBe(true);

    fireEvent.change(repoInput(), { target: { value: "https://github.com/acme/other" } });
    fireEvent.click(saveButton()!);

    await waitFor(() =>
      expect(service.updateSettings).toHaveBeenCalledWith("acme", "p1", { repo_url: "https://github.com/acme/other" })
    );
    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith({ type: "success", title: "coding_jobs.settings.saved" })
    );
  });

  it("shows the API's field error under the field", async () => {
    await setup({
      updateSettings: vi.fn().mockRejectedValue(
        new CodingJobServiceError(400, {
          error: "The request is not valid.",
          errors: { repo_url: ["Leave credentials out of the repository URL."] },
        })
      ),
    });

    fireEvent.change(repoInput(), { target: { value: "https://user@github.com/acme/app" } });
    fireEvent.click(saveButton()!);

    expect(await screen.findByText("Leave credentials out of the repository URL.")).toBeTruthy();
  });

  it("shows members the settings read-only", async () => {
    mocks.role = "member";
    await setup();

    expect(repoInput().disabled).toBe(true);
    expect(screen.getByText("coding_jobs.settings.read_only")).toBeTruthy();
    expect(saveButton()).toBeNull();
    expect(createFailedButton()).toBeNull();
  });

  it("lets a workspace admin who is a project member edit", async () => {
    mocks.role = "member";
    mocks.workspaceRole = "admin";
    await setup();
    expect(repoInput().disabled).toBe(false);
    expect(createFailedButton()).not.toBeNull();
  });

  it("locks the form while the Failed column is being created", async () => {
    mocks.createState.mockReturnValue(new Promise(() => undefined));
    await setup();
    fireEvent.change(repoInput(), { target: { value: "https://github.com/acme/other" } });

    fireEvent.click(createFailedButton()!);

    await waitFor(() => expect(repoInput().disabled).toBe(true));
    expect(saveButton()?.hasAttribute("disabled")).toBe(true);
  });

  it("reloads the settings when the state was created but choosing it failed", async () => {
    mocks.createState.mockResolvedValue({ id: "s-failed", name: "Failed" });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce(makeSettings())
      .mockResolvedValue(
        makeSettings({
          columns: { ready: null, failed: { id: "s-failed", name: "Failed", chosen: false }, in_review: null },
        })
      );
    await setup({
      getSettings,
      updateSettings: vi.fn().mockRejectedValue(new CodingJobServiceError(400, { error: "No." })),
    });

    fireEvent.click(createFailedButton()!);

    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(createFailedButton()).toBeNull());
  });

  it("shows another endpoint's error message when creating the state fails", async () => {
    mocks.createState.mockRejectedValue({ error: "A state with this name already exists." });
    await setup();

    fireEvent.click(createFailedButton()!);

    await waitFor(() =>
      expect(mocks.setToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: "A state with this name already exists." })
      )
    );
  });

  it("creates a Failed column and sets it as the Failed state", async () => {
    mocks.createState.mockResolvedValue({ id: "s-failed", name: "Failed" });
    const service = await setup({
      updateSettings: vi.fn().mockResolvedValue(
        makeSettings({
          failed_state: "s-failed",
          columns: {
            ready: { id: "s-ready", name: "Ready", chosen: false },
            failed: { id: "s-failed", name: "Failed", chosen: true },
            in_review: { id: "s-review", name: "In review", chosen: false },
          },
        })
      ),
    });

    fireEvent.click(createFailedButton()!);

    await waitFor(() =>
      expect(mocks.createState).toHaveBeenCalledWith("acme", "p1", expect.objectContaining({ name: "Failed" }))
    );
    await waitFor(() =>
      expect(service.updateSettings).toHaveBeenCalledWith("acme", "p1", { failed_state: "s-failed" })
    );
    await waitFor(() => expect(createFailedButton()).toBeNull());
    expect(screen.getByText('coding_jobs.settings.resolves_to {"state":"Failed"}')).toBeTruthy();
  });

  it("offers no Create Failed column button when the project has one", async () => {
    await setup({
      getSettings: vi.fn().mockResolvedValue(
        makeSettings({
          columns: {
            ready: null,
            failed: { id: "s-x", name: "Failed", chosen: false },
            in_review: null,
          },
        })
      ),
    });
    expect(createFailedButton()).toBeNull();
  });

  describe("pull request status", () => {
    const status = () => within(screen.getByTestId("coding-repository-status"));

    it("says pull requests are on, and whether the repository is private", async () => {
      const service = await setup();
      await waitFor(() => expect(service.getRepository).toHaveBeenCalledWith("acme", "p1"));
      expect(await status().findByText("coding_jobs.repository.ready_private")).toBeTruthy();
      expect(status().queryByRole("link")).toBeNull();
    });

    it("says it for a public repository too", async () => {
      await setup({ getRepository: vi.fn().mockResolvedValue(makeRepository({ private: false })) });
      expect(await status().findByText("coding_jobs.repository.ready_public")).toBeTruthy();
    });

    it("shows the reason, as text, and a link to install the GitHub App when it is not installed", async () => {
      await setup({
        getRepository: vi.fn().mockResolvedValue(
          makeRepository({
            pull_requests: false,
            installed: false,
            private: null,
            install_url: "https://github.com/apps/nexus-crm/installations/new",
            reason: "The GitHub App is not installed on <b>acme/app</b>.",
          })
        ),
      });

      const reason = await status().findByText("The GitHub App is not installed on <b>acme/app</b>.");
      expect(reason.querySelector("b")).toBeNull();
      expect(status().getByRole("link", { name: "coding_jobs.repository.install" }).getAttribute("href")).toBe(
        "https://github.com/apps/nexus-crm/installations/new"
      );
    });

    it("shows no install link once the App is installed or when the link is not https", async () => {
      await setup({
        getRepository: vi.fn().mockResolvedValue(
          makeRepository({
            pull_requests: false,
            installed: null,
            install_url: "javascript:alert(1)",
            reason: null,
          })
        ),
      });
      expect(await status().findByText("coding_jobs.repository.off")).toBeTruthy();
      expect(status().queryByRole("link")).toBeNull();
    });

    it("keeps the form working when the check fails, and checks again on request", async () => {
      const getRepository = vi
        .fn()
        .mockRejectedValueOnce(new CodingJobServiceError(502, { error: "GitHub did not answer." }))
        .mockResolvedValue(makeRepository());
      await setup({ getRepository });

      expect(await status().findByText("coding_jobs.repository.check_failed")).toBeTruthy();
      expect(repoInput().disabled).toBe(false);

      fireEvent.click(status().getByRole("button", { name: "coding_jobs.repository.check_again" }));
      expect(await status().findByText("coding_jobs.repository.ready_private")).toBeTruthy();
      expect(getRepository).toHaveBeenCalledTimes(2);
    });

    it("shows the form while the check is still running", async () => {
      await setup({ getRepository: vi.fn().mockReturnValue(new Promise(() => undefined)) });
      expect(status().getByText("coding_jobs.repository.checking")).toBeTruthy();
      expect(repoInput().disabled).toBe(false);
    });
  });
});
