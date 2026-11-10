/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";
import { IssueDetailQuickActions } from "./issue-detail-quick-actions";

const mocks = vi.hoisted(() => ({
  setToast: vi.fn(),
  push: vi.fn(),
  removeIssue: vi.fn(),
  archiveIssue: vi.fn(),
}));

const ISSUE = {
  id: "issue-1",
  name: "Row",
  project_id: "project-1",
  sequence_id: 1,
  created_by: "user-1",
  archived_at: null,
} as unknown as TIssue;

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/i18n")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
// a plain confirm button stands in for the dialog, so the test drives each modal's submit handler directly
vi.mock("@plane/blocks/dialog", () => ({
  ConfirmDialog: ({ isOpen, title, handleSubmit }: { isOpen: boolean; title: string; handleSubmit: () => void }) =>
    isOpen ? (
      <button type="button" onClick={handleSubmit}>
        {title}
      </button>
    ) : null,
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: { getIssueById: () => ISSUE },
    removeIssue: mocks.removeIssue,
    archiveIssue: mocks.archiveIssue,
  }),
}));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({ issueMap: {}, issues: { restoreIssue: vi.fn(), removeIssue: vi.fn() } }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    getProjectIdentifierById: () => "ACME",
    getProjectById: () => ({ id: "project-1", identifier: "ACME" }),
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "user-1" } }),
  useUserPermissions: () => ({ allowPermissions: () => true }),
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("./subscription", () => ({ IssueSubscription: () => null }));
// the real delete and archive modals, opened at once, wired to the handlers the page passes down
vi.mock("../issue-layouts/quick-action-dropdowns", async () => {
  const { DeleteIssueModal } = await import("../delete-issue-modal");
  const { ArchiveIssueModal } = await import("../archive-issue-modal");
  return {
    WorkItemDetailQuickActions: (props: {
      issue: TIssue;
      handleDelete: () => Promise<void>;
      handleArchive: () => Promise<void>;
    }) => (
      <>
        <DeleteIssueModal isOpen data={props.issue} handleClose={() => undefined} onSubmit={props.handleDelete} />
        <ArchiveIssueModal isOpen data={props.issue} handleClose={() => undefined} onSubmit={props.handleArchive} />
      </>
    ),
  };
});

const renderActions = () =>
  render(<IssueDetailQuickActions workspaceSlug="acme" projectId="project-1" issueId="issue-1" />);

const toastTypes = () => mocks.setToast.mock.calls.map(([toast]) => (toast as { type: string }).type);

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  { action: "delete", button: /entity\.delete\.label/, store: mocks.removeIssue },
  { action: "archive", button: /issue\.archive\.label/, store: mocks.archiveIssue },
])("work item detail $action", ({ button, store }) => {
  it("shows one error toast and stays on the page when the request fails", async () => {
    store.mockRejectedValue({ error: "Something went wrong" });
    renderActions();

    await userEvent.click(screen.getByRole("button", { name: button }));

    await waitFor(() => expect(mocks.setToast).toHaveBeenCalled());
    expect(toastTypes()).toEqual(["error"]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("shows one success toast and leaves the page when the request succeeds", async () => {
    store.mockResolvedValue(undefined);
    renderActions();

    await userEvent.click(screen.getByRole("button", { name: button }));

    await waitFor(() => expect(mocks.setToast).toHaveBeenCalled());
    expect(toastTypes()).toEqual(["success"]);
    expect(mocks.push).toHaveBeenCalledWith("/acme/projects/project-1/issues");
  });
});
