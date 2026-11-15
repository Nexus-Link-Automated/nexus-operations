/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadingListExtension } from "../headings-list";

let editor: Editor;
const createEditor = (content: string) => {
  editor = new Editor({
    element: document.createElement("div"),
    content,
    extensions: [StarterKit, HeadingListExtension],
  });
  return editor;
};
const headings = () => editor.storage.headingsList.headings.map(({ level, text }) => `${level}:${text}`);

afterEach(() => editor.destroy());

describe("HeadingListExtension", () => {
  it("lists the headings of the initial content before any transaction", () => {
    createEditor("<h1>Intro</h1><p>body</p><h2>Details</h2>");
    expect(headings()).toEqual(["1:Intro", "2:Details"]);
  });

  it("does not emit an update when only the selection moves", () => {
    createEditor("<h1>Intro</h1><p>body</p>");
    const onUpdate = vi.fn();
    editor.on("update", onUpdate);
    editor.commands.setTextSelection(3);
    editor.commands.setTextSelection(9);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("recomputes the headings when the document changes", () => {
    createEditor("<h1>Intro</h1><p>body</p>");
    const onUpdate = vi.fn();
    editor.on("update", onUpdate);
    editor.commands.insertContentAt(editor.state.doc.content.size, "<h3>Next</h3>");
    expect(headings()).toEqual(["1:Intro", "3:Next"]);
    expect(onUpdate).toHaveBeenCalled();
  });
});
