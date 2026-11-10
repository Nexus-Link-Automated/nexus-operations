/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IIssueDisplayProperties, TIssue } from "@plane/types";
import { IssueColumn } from "./issue-column";

const setToast = vi.hoisted(() => vi.fn());

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/i18n")>()),
  useTranslation: () => ({
    t: (key: string, params?: { entity?: string }) => (params?.entity ? `${key}:${params.entity}` : key),
  }),
}));
vi.mock("@plane/blocks/toast", () => ({ setToast }));
vi.mock("@/helpers/issue-filter.helper", () => ({ shouldRenderColumn: () => true }));
// a stand-in priority cell that changes the value when clicked, the way the real dropdown does
vi.mock("../utils", () => ({
  SPREADSHEET_COLUMNS: {
    priority: ({ issue, onChange }: { issue: TIssue; onChange: (issue: TIssue, data: Partial<TIssue>) => void }) => (
      <button type="button" onClick={() => onChange(issue, { priority: "urgent" })}>
        priority
      </button>
    ),
  },
}));

const ISSUE = { id: "issue-1", project_id: "project-1", priority: "none" } as TIssue;

const renderColumn = (
  updateIssue: (projectId: string | null, issueId: string, data: Partial<TIssue>) => Promise<void>,
  issue: TIssue = ISSUE
) =>
  render(
    <table>
      <tbody>
        <tr>
          <IssueColumn
            displayProperties={{ priority: true } as IIssueDisplayProperties}
            issueDetail={issue}
            disableUserActions={false}
            property="priority"
            updateIssue={updateIssue}
            isEstimateEnabled={false}
          />
        </tr>
      </tbody>
    </table>
  );

beforeEach(() => {
  setToast.mockClear();
});

describe("spreadsheet cell edits", () => {
  it("tells the user when the change could not be saved", async () => {
    const updateIssue = vi.fn().mockRejectedValue({ error: "server refused" });
    renderColumn(updateIssue);

    await userEvent.click(screen.getByRole("button", { name: "priority" }));

    await waitFor(() => expect(setToast).toHaveBeenCalledTimes(1));
    expect(updateIssue).toHaveBeenCalledWith("project-1", "issue-1", { priority: "urgent" });
    expect(setToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "entity.update.failed:issue.label" })
    );
  });

  it("names an epic as such", async () => {
    renderColumn(vi.fn().mockRejectedValue(new Error("server refused")), { ...ISSUE, is_epic: true });

    await userEvent.click(screen.getByRole("button", { name: "priority" }));

    await waitFor(() =>
      expect(setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "entity.update.failed:common.epic" }))
    );
  });

  it("stays quiet when the change saves", async () => {
    const updateIssue = vi.fn().mockResolvedValue(undefined);
    renderColumn(updateIssue);

    await userEvent.click(screen.getByRole("button", { name: "priority" }));

    await waitFor(() => expect(updateIssue).toHaveBeenCalled());
    expect(setToast).not.toHaveBeenCalled();
  });
});
