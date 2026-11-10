/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { forwardRef, useEffect, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TCommentsOperations } from "@plane/types";
import { CommentCreate } from "./comment-create";

const mocks = vi.hoisted(() => ({ clearEditor: vi.fn() }));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws" }) }) }));
vi.mock("@/services/file.service", () => ({ FileService: class {} }));
vi.mock("@/components/editor/lite-text/toolbar", () => ({ IssueCommentToolbar: () => null }));
vi.mock("@plane/blocks/comment-box", () => ({
  CommentBox: ({ editor, onSubmit }: { editor: ReactNode; onSubmit: () => void }) => (
    <div>
      {editor}
      <button type="button" onClick={onSubmit}>
        submit
      </button>
    </div>
  ),
}));
// A plain textarea stands in for the rich editor; it exposes the ref methods the box relies on.
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: forwardRef(function LiteTextEditor(
    props: { onChange: (json: unknown, html: string) => void; handleEditorReady: (ready: boolean) => void },
    ref
  ) {
    const { onChange, handleEditorReady } = props;
    useImperativeHandle(ref, () => ({ clearEditor: mocks.clearEditor, isEditorReadyToDiscard: () => true }));
    useEffect(() => handleEditorReady(true), [handleEditorReady]);
    return <textarea aria-label="comment" onChange={(e) => onChange({}, `<p>${e.target.value}</p>`)} />;
  }),
}));

function renderBox(createComment: TCommentsOperations["createComment"]) {
  const activityOperations = { createComment } as TCommentsOperations;
  render(
    <CommentCreate
      workspaceSlug="workspace"
      entityId="issue"
      projectId="project"
      activityOperations={activityOperations}
    />
  );
  fireEvent.change(screen.getByLabelText("comment"), { target: { value: "My comment" } });
  return () => fireEvent.click(screen.getByText("submit"));
}

describe("CommentCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the comment when posting fails, so it can be posted again", async () => {
    const createComment = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: "c1" });
    const submit = renderBox(createComment);

    submit();
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
    expect(mocks.clearEditor).not.toHaveBeenCalled();

    submit();
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(2));
    expect(createComment).toHaveBeenLastCalledWith(expect.objectContaining({ comment_html: "<p>My comment</p>" }));
    await waitFor(() => expect(mocks.clearEditor).toHaveBeenCalledTimes(1));
  });

  it("clears the box once the comment is posted", async () => {
    const createComment = vi.fn().mockResolvedValue({ id: "c1" });
    const submit = renderBox(createComment);

    submit();
    await waitFor(() => expect(mocks.clearEditor).toHaveBeenCalledTimes(1));
  });
});
