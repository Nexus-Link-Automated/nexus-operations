/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorRefApi } from "@plane/editor";

const mocks = vi.hoisted(() => ({ replaceHTML: vi.fn(({ htmlContent }: { htmlContent: string }) => htmlContent) }));

vi.mock("react-router", () => ({ useParams: () => ({ workspaceSlug: "acme", projectId: "project-1" }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: vi.fn() }));
vi.mock("@/components/editor/pdf", () => ({ PDFDocument: () => null }));
vi.mock("@react-pdf/renderer", () => ({ pdf: () => ({ toBlob: () => Promise.resolve(new Blob()) }) }));
vi.mock("@/hooks/use-parse-editor-content", () => ({
  useParseEditorContent: () => ({
    replaceCustomComponentsFromHTMLContent: mocks.replaceHTML,
    replaceCustomComponentsFromMarkdownContent: vi.fn(),
  }),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { ExportPageModal } from "./export-page-modal";

const editorRef = { getDocument: () => ({ html: "<p>Body</p>" }) } as unknown as EditorRefApi;

describe("ExportPageModal", () => {
  it.each(["R&amp;D plan", "Use Array<T> in types", "<b>Bold</b> move"])(
    "keeps the title %j as text in the exported PDF",
    async (title) => {
      URL.createObjectURL = vi.fn(() => "blob:export");
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      render(<ExportPageModal editorRef={editorRef} isOpen onClose={vi.fn()} pageTitle={title} />);

      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(mocks.replaceHTML).toHaveBeenCalled());

      const { htmlContent } = mocks.replaceHTML.mock.lastCall![0];
      const heading = new DOMParser().parseFromString(htmlContent, "text/html").querySelector("h1.page-title");
      expect(heading?.textContent).toBe(title);
    }
  );
});
