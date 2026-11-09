/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";
import { InboxIssueMainContent } from "@/components/inbox/content/issue-root";
import type { IInboxIssueStore } from "@/store/inbox/inbox-issue.store";
import type { TIssueOperations } from "./issue-detail";
import { IssueMainContent } from "./issue-detail/main-content";
import { PeekOverviewIssueDetails } from "./peek-overview/issue-detail";

const mocks = vi.hoisted(() => ({
  issues: {} as Record<string, unknown>,
  nothing: () => null,
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: { getIssueById: (id: string) => mocks.issues[id], getIsFetchingIssueDetails: () => false },
    peekIssue: undefined,
    removeIssue: vi.fn(),
    archiveIssue: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: () => undefined }) }));
vi.mock("@/hooks/store/use-project-inbox", () => ({ useProjectInbox: () => ({ loader: undefined }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user" } }) }));
vi.mock("@/hooks/use-reload-confirmation", () => ({ default: () => ({ setShowAlert: vi.fn() }) }));
vi.mock("@/hooks/use-window-size", () => ({ default: () => [1280, 800] }));
vi.mock("@/services/issue", () => ({
  WorkItemVersionService: class {
    listDescriptionVersions = vi.fn();
  },
}));
vi.mock("@/services/inbox", () => ({
  IntakeWorkItemVersionService: class {
    listDescriptionVersions = vi.fn();
  },
}));

// Everything on these pages except the title input itself.
vi.mock("@/components/core/description-versions", () => ({ DescriptionVersionsRoot: mocks.nothing }));
vi.mock("@/components/editor/rich-text/description-input", () => ({ DescriptionInput: mocks.nothing }));
vi.mock("@/components/editor/rich-text/description-input/loader", () => ({ DescriptionInputLoader: mocks.nothing }));
vi.mock("@/components/issues/attachment", () => ({ IssueAttachmentRoot: mocks.nothing }));
vi.mock("@/components/issues/issue-type-switcher", () => ({ IssueTypeSwitcher: mocks.nothing }));
vi.mock("@/components/inbox/content/issue-properties", () => ({ InboxIssueContentProperties: mocks.nothing }));
vi.mock("./issue-detail-widgets", () => ({ IssueDetailWidgets: mocks.nothing }));
vi.mock("./issue-update-status", () => ({ NameDescriptionUpdateStatus: mocks.nothing }));
vi.mock("./peek-overview/properties", () => ({ PeekOverviewProperties: mocks.nothing }));
vi.mock("./issue-detail/description-overflow", () => ({ DescriptionOverflow: mocks.nothing }));
vi.mock("./issue-detail/detail-meta-row", () => ({ IssueDetailMetaRow: mocks.nothing }));
vi.mock("./issue-detail/issue-activity", () => ({ IssueActivity: mocks.nothing }));
vi.mock("./issue-detail/parent", () => ({ IssueParentDetail: mocks.nothing }));
vi.mock("./issue-detail/reactions", () => ({ IssueReaction: mocks.nothing }));

const WORKSPACE = "workspace";
const NEW_TITLE = "Renamed by the user";
const issueA = { id: "issue-a", project_id: "project-a", name: "Title A", description_html: "<p></p>" };
const issueB = { id: "issue-b", project_id: "project-b", name: "Title B", description_html: "<p></p>" };

const update = vi.fn();
const issueOperations = { update, fetch: vi.fn(), remove: vi.fn(), archive: vi.fn() } as unknown as TIssueOperations;

type TestIssue = typeof issueA;

const inboxIssues = new Map<string, IInboxIssueStore>(
  [issueA, issueB].map((issue) => [
    issue.id,
    {
      issue,
      status: 0,
      // Intake ignores the IDs it is passed and updates the store object it closed over.
      updateIssue: (data: Partial<TIssue>) => update(WORKSPACE, issue.project_id, issue.id, data),
    } as unknown as IInboxIssueStore,
  ])
);

const renderSites: [string, (issue: TestIssue) => ReactElement][] = [
  [
    "the work item page",
    (issue) => (
      <IssueMainContent
        workspaceSlug={WORKSPACE}
        projectId={issue.project_id}
        issueId={issue.id}
        issueOperations={issueOperations}
        isEditable
        isArchived={false}
      />
    ),
  ],
  [
    "the peek view",
    (issue) => (
      <PeekOverviewIssueDetails
        editorRef={{ current: null }}
        workspaceSlug={WORKSPACE}
        projectId={issue.project_id}
        issueId={issue.id}
        issueOperations={issueOperations}
        disabled={false}
        isArchived={false}
        isSubmitting="saved"
        setIsSubmitting={vi.fn()}
      />
    ),
  ],
  [
    "the intake page",
    (issue) => (
      <InboxIssueMainContent
        workspaceSlug={WORKSPACE}
        projectId={issue.project_id}
        inboxIssue={inboxIssues.get(issue.id) as IInboxIssueStore}
        isEditable
        isSubmitting="saved"
        setIsSubmitting={vi.fn()}
      />
    ),
  ],
];

const typeTitle = () => fireEvent.change(screen.getByRole("textbox"), { target: { value: NEW_TITLE } });

describe.each(renderSites)("IssueTitleInput on %s", (_siteName, site) => {
  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue(undefined);
    mocks.issues = { [issueA.id]: issueA, [issueB.id]: issueB };
  });

  it("saves to the work item on screen when the page is reused for another one", () => {
    const { rerender, unmount } = render(site(issueB));
    rerender(site(issueA));

    typeTitle();
    unmount();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(WORKSPACE, issueA.project_id, issueA.id, { name: NEW_TITLE });
  });

  it("saves a pending edit to the work item it was typed in when moving to another one", () => {
    const { rerender } = render(site(issueA));

    typeTitle();
    rerender(site(issueB));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(WORKSPACE, issueA.project_id, issueA.id, { name: NEW_TITLE });
    expect(screen.getByRole("textbox")).toHaveProperty("value", issueB.name);
  });
});
