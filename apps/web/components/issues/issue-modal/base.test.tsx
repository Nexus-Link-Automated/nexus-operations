/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";
import type { IssueFormProps } from "./form";
import { CreateUpdateIssueModalBase } from "./base";

const mocks = vi.hoisted(() => ({
  formProps: undefined as IssueFormProps | undefined,
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  addIssueToCycle: vi.fn(),
  changeModulesInIssue: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@makeplane/propel/components/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "workspace" }) }));
vi.mock("@/hooks/context/use-issue-modal", () => ({
  useIssueModal: () => ({
    allowedProjectIds: ["project"],
    handleCreateUpdatePropertyValues: vi.fn(),
    handleCreateSubWorkItem: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-cycle", () => ({ useCycle: () => ({ fetchCycleDetails: vi.fn() }) }));
vi.mock("@/hooks/store/use-module", () => ({ useModule: () => ({ fetchModuleDetails: vi.fn() }) }));
vi.mock("@/hooks/store/use-issue-detail", () => ({ useIssueDetail: () => ({ fetchIssue: vi.fn() }) }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectByIdentifier: () => undefined }) }));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({
    issues: { addIssueToCycle: mocks.addIssueToCycle, changeModulesInIssue: mocks.changeModulesInIssue },
  }),
}));
vi.mock("@/hooks/use-issue-layout-store", () => ({ useIssueStoreType: () => "PROJECT" }));
vi.mock("@/hooks/use-issues-actions", () => ({
  useIssuesActions: () => ({ createIssue: mocks.createIssue, updateIssue: mocks.updateIssue }),
}));
vi.mock("@/services/file.service", () => ({ FileService: class {} }));
vi.mock("../create-issue-toast-action-items", () => ({ useCreateIssueToastActions: () => () => [] }));
vi.mock("./draft-issue-layout", () => ({ DraftIssueLayout: () => null }));
vi.mock("./form", () => ({
  IssueFormRoot: (props: IssueFormProps) => {
    mocks.formProps = props;
    return null;
  },
}));

const existingIssue = { id: "issue", project_id: "project", name: "Old title" } as Partial<TIssue>;

function renderModal(props: {
  data?: Partial<TIssue>;
  onClose?: () => void;
  onSubmit?: (res: TIssue) => Promise<void>;
}) {
  render(
    <CreateUpdateIssueModalBase
      isOpen
      onClose={props.onClose ?? vi.fn()}
      onSubmit={props.onSubmit}
      data={props.data}
      withDraftIssueWrapper={false}
      fetchIssueDetails={false}
    />
  );
  if (!mocks.formProps) throw new Error("form was not rendered");
  return mocks.formProps;
}

describe("CreateUpdateIssueModalBase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.formProps = undefined;
  });

  it("rejects a failed update so the form keeps the user's edits", async () => {
    mocks.updateIssue.mockRejectedValue({ error: "server error" });
    const onClose = vi.fn();
    const form = renderModal({ data: existingIssue, onClose });

    await expect(form.onSubmit({ project_id: "project", name: "New title" })).rejects.toEqual({
      error: "server error",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});
