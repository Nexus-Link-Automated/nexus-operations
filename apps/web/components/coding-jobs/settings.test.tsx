/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "@plane/services";
import { CodingJobStore } from "@/store/coding-job.store";
import type { TRole } from "./test-utils";
import { allowPermissionsFor, fakeCodingService, makeSettings } from "./test-utils";

const mocks = vi.hoisted(() => ({
  store: undefined as unknown,
  role: "admin" as string,
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
  useUserPermissions: () => ({
    allowPermissions: (...args: Parameters<ReturnType<typeof allowPermissionsFor>>) =>
      allowPermissionsFor(mocks.role as TRole)(...args),
  }),
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
});
