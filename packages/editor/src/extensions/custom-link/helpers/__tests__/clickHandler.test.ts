/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomLinkExtension } from "../../extension";

const NEW_TAB_FEATURES = "noopener,noreferrer";

let editor: Editor;
let openSpy: ReturnType<typeof vi.spyOn>;

const createEditor = (linkAttrs: Record<string, unknown>, formatted: boolean) => {
  // Built from JSON so that the mark keeps these exact attribute values.
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ link: false }), CustomLinkExtension],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link text",
              marks: [{ type: "link", attrs: linkAttrs }, ...(formatted ? [{ type: "bold" }] : [])],
            },
          ],
        },
      ],
    },
  });
  editor.commands.setTextSelection(3);
  return editor;
};

const clickOn = (element: Element | null) => {
  const event = { button: 0, target: element } as unknown as MouseEvent;
  return editor.view.someProp("handleClick", (handleClick) => handleClick(editor.view, 3, event));
};

const clickFormattedText = (linkAttrs: Record<string, unknown>) => {
  createEditor(linkAttrs, true);
  return clickOn(editor.view.dom.querySelector("a strong"));
};

const clickAnchor = (linkAttrs: Record<string, unknown>) => {
  createEditor(linkAttrs, false);
  return clickOn(editor.view.dom.querySelector("a"));
};

beforeEach(() => {
  vi.stubGlobal("location", new URL("https://app.example.test/workspace/page"));
  openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("clickHandler", () => {
  describe("when the click lands on formatted text inside a link", () => {
    it.each([
      ["an https link", " https://example.com/page", "https://example.com/page"],
      ["an http link", "\thttp://example.com/page", "http://example.com/page"],
      ["a mailto link", " mailto:team@example.com", "mailto:team@example.com"],
      ["a root-relative link", "/workspace/other", "https://app.example.test/workspace/other"],
      ["a path-relative link", "other", "https://app.example.test/workspace/other"],
    ])("opens %s at its resolved URL", (_label, href, resolved) => {
      expect(clickFormattedText({ href })).toBe(true);
      expect(openSpy).toHaveBeenCalledExactlyOnceWith(resolved, "_blank", NEW_TAB_FEATURES);
    });

    it.each([
      ["a tab inside the protocol", "java\tscript:void(0)"],
      ["a line break inside the protocol", "java\nscript:void(0)"],
      ["whitespace before the protocol", " javascript:void(0)"],
      ["a line break before the protocol", "\ndata:text/plain,hello"],
      ["a blob protocol", "blob:https://example.com/file-id"],
      ["an ftp protocol", "ftp://example.com/file"],
    ])("leaves a link with %s unopened", (_label, href) => {
      expect(clickFormattedText({ href, target: "_self" })).toBeFalsy();
      expect(openSpy).not.toHaveBeenCalled();
    });

    it.each(["_self", "_top", "named-window"])("opens a link stored with target %s in a new tab", (target) => {
      clickFormattedText({ href: "https://example.com/page", target });
      expect(openSpy).toHaveBeenCalledExactlyOnceWith("https://example.com/page", "_blank", NEW_TAB_FEATURES);
    });
  });

  describe("when the click lands on the link element", () => {
    it("opens the link at its resolved URL in a new tab", () => {
      expect(clickAnchor({ href: "https://example.com/page", target: "_top" })).toBe(true);
      expect(openSpy).toHaveBeenCalledExactlyOnceWith("https://example.com/page", "_blank", NEW_TAB_FEATURES);
    });

    it("leaves a link with a protocol outside the allowed list unopened", () => {
      expect(clickAnchor({ href: "ftp://example.com/file" })).toBeFalsy();
      expect(openSpy).not.toHaveBeenCalled();
    });
  });
});
