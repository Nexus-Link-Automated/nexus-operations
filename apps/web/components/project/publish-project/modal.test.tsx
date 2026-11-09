/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initPromise } from "@plane/i18n";
import { PublishProjectModal } from "./modal";

const mocks = vi.hoisted(() => ({
  setToast: vi.fn(),
  fetchPublishSettings: vi.fn(),
  publishProject: vi.fn(),
  updatePublishSettings: vi.fn(),
  unPublishProject: vi.fn(),
}));

const SETTINGS = {
  id: "publish-1",
  anchor: "abc123",
  is_comments_enabled: false,
  is_reactions_enabled: false,
  is_votes_enabled: false,
  inbox: null,
  view_props: { list: true, kanban: true },
};

vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "acme" }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-project-publish", () => ({
  useProjectPublish: () => ({
    fetchPublishSettings: mocks.fetchPublishSettings,
    getPublishSettingsByProjectID: () => SETTINGS,
    publishProject: mocks.publishProject,
    updatePublishSettings: mocks.updatePublishSettings,
    unPublishProject: mocks.unPublishProject,
    fetchSettingsLoader: false,
  }),
}));

function renderModal() {
  const onClose = vi.fn();
  render(<PublishProjectModal isOpen projectId="project-1" onClose={onClose} />);
  return { onClose };
}

/** Presses the publish modal's Unpublish button and returns the confirmation that opens. */
async function openConfirmation() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Unpublish" }));
  const confirmation = await screen.findByRole("alertdialog");
  return { user, confirmation };
}

describe("PublishProjectModal unpublish confirmation", { timeout: 20_000 }, () => {
  // The app waits for the translation catalog before it renders (entry.client.tsx); so do these tests.
  beforeAll(async () => {
    await initPromise;
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unPublishProject.mockResolvedValue(undefined);
  });

  it("asks for confirmation, stating what happens to the link, before sending anything", async () => {
    renderModal();
    const { confirmation } = await openConfirmation();

    expect(within(confirmation).getByRole("heading", { name: "Unpublish project" })).toBeTruthy();
    expect(within(confirmation).getByText(/The current public link will stop working/)).toBeTruthy();
    expect(within(confirmation).getByText(/Publishing this project again creates a new link/)).toBeTruthy();
    expect(mocks.unPublishProject).not.toHaveBeenCalled();
  });

  it("sends nothing on Cancel and leaves the publish modal open", async () => {
    const { onClose } = renderModal();
    const { user, confirmation } = await openConfirmation();

    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.unPublishProject).not.toHaveBeenCalled();
    expect(mocks.setToast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Unpublish" })).toBeTruthy();
  });

  it("sends the unpublish request on Confirm and closes the confirmation", async () => {
    const { onClose } = renderModal();
    const { user, confirmation } = await openConfirmation();

    await user.click(within(confirmation).getByRole("button", { name: "Unpublish" }));

    await waitFor(() => expect(mocks.unPublishProject).toHaveBeenCalledTimes(1));
    expect(mocks.unPublishProject).toHaveBeenCalledWith("acme", "project-1", "publish-1");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mocks.setToast).not.toHaveBeenCalled();
    expect(mocks.updatePublishSettings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows an error and keeps the project published when the request fails", async () => {
    mocks.unPublishProject.mockRejectedValue(new Error("boom"));
    const { onClose } = renderModal();
    const { user, confirmation } = await openConfirmation();

    await user.click(within(confirmation).getByRole("button", { name: "Unpublish" }));

    await waitFor(() => expect(mocks.setToast).toHaveBeenCalledTimes(1));
    expect(mocks.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "Something went wrong while unpublishing the project.",
      })
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/\/issues\/abc123$/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    // The confirmation stays usable, so the unpublish can be retried or cancelled.
    await waitFor(() =>
      expect(within(confirmation).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false)
    );
  });
});
