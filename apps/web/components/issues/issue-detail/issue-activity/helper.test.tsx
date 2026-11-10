/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkItemCommentOperations } from "./helper";

const mocks = vi.hoisted(() => ({ createComment: vi.fn(), setToast: vi.fn() }));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    commentReaction: {},
    createComment: mocks.createComment,
    issue: { getIssueById: () => undefined },
  }),
}));
vi.mock("@/hooks/store/use-editor-asset", () => ({ useEditorAsset: () => ({}) }));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({}) }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: () => undefined }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user" } }) }));

describe("useWorkItemCommentOperations", () => {
  it("rejects when posting a comment fails, after showing the error", async () => {
    const failure = new Error("offline");
    mocks.createComment.mockRejectedValue(failure);
    const { result } = renderHook(() => useWorkItemCommentOperations("workspace", "project", "issue"));

    await expect(result.current.createComment({ comment_html: "<p>hi</p>" })).rejects.toBe(failure);
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});
