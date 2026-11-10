/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The mention chip is the editor's own, with its member lookups; here it only shows what it was given.
vi.mock("@/components/editor/embeds/mentions", () => ({
  EditorMentionsRoot: ({ entity_identifier, entity_name }: { entity_identifier: string; entity_name: string }) => (
    <span data-testid="mention">{`${entity_name}:${entity_identifier}`}</span>
  ),
}));

const { ChatMessageBody, safeHref } = await import("./message-body");

const body = (html: string) => {
  const { container } = render(<ChatMessageBody id="chat-message-m1" html={html} />);
  return container.querySelector(".ProseMirror")!;
};

describe("ChatMessageBody", () => {
  it("renders the editor's HTML without an editor, with the classes the editor's styles expect", () => {
    const el = body(
      '<p class="editor-paragraph-block">Hello <strong>bold</strong> <em>it</em> <u>u</u> <s>gone</s> ' +
        '<code class="x">inline</code></p>' +
        '<ul class="list-disc"><li class="not-prose"><p class="editor-paragraph-block">one</p></li></ul>' +
        '<ol start="3"><li><p>three</p></li></ol>' +
        '<pre><code class="language-ts">const a = 1;\n  b();</code></pre>' +
        "<blockquote><p>quoted</p></blockquote>" +
        '<div data-type="horizontalRule"><div></div></div>'
    );

    expect(el.closest(".editor-container")?.className).toContain("small-font");
    expect(el.id).toBe("chat-message-m1");
    expect(el.querySelector("[contenteditable]")).toBeNull();
    expect(el.querySelector("p")?.className).toBe("editor-paragraph-block");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    expect(el.querySelector("em")?.textContent).toBe("it");
    expect(el.querySelector("u")?.textContent).toBe("u");
    expect(el.querySelector("s")?.textContent).toBe("gone");
    expect(el.querySelector("p > code")?.className).toContain("font-code");
    expect(el.querySelector("ul")?.className).toContain("list-disc");
    expect(el.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(el.querySelector("pre > code")?.textContent).toBe("const a = 1;\n  b();");
    expect(el.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(el.querySelector('[data-type="horizontalRule"]')).not.toBeNull();
  });

  it("shows mentions with the editor's mention chip", () => {
    body(
      '<p>Hi <mention-component id="x" entity_identifier="user-ada" entity_name="user_mention"></mention-component>!</p>'
    );
    expect(screen.getByTestId("mention").textContent).toBe("user_mention:user-ada");
  });

  it("shows a to-do list as read-only checkboxes", () => {
    const el = body(
      '<ul data-type="taskList">' +
        '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li>' +
        '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li>' +
        "</ul>"
    );
    const boxes = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
    expect(el.querySelector('li[data-checked="true"] > div')?.textContent).toBe("done");
    expect(screen.getByRole("checkbox", { name: "done" })).toBe(boxes[0]);
  });

  it("opens safe links in a new tab and keeps only the text of unsafe ones", () => {
    const el = body(
      '<p><a href="https://example.com/x" target="_self" class="fixed inset-0">site</a> ' +
        '<a href="/acme/browse/EMP-1/">item</a> ' +
        '<a href="javascript:alert(1)">bad</a> <a href="java\tscript:alert(1)">tabbed</a></p>'
    );
    const links = [...el.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/x",
      `${window.location.origin}/acme/browse/EMP-1/`,
    ]);
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(links[0]!.className).not.toContain("fixed");
    expect(el.textContent).toContain("bad");
    expect(el.textContent).toContain("tabbed");
  });

  it("drops scripts, embeds and handlers, and copies no classes or styles from the HTML", () => {
    const el = body(
      '<p class="fixed inset-0 z-50" style="position:fixed" onclick="alert(1)">text</p>' +
        "<script>alert(1)</script><style>p{display:none}</style>" +
        '<img src="https://example.com/x.png" onerror="alert(1)"><iframe src="https://example.com"></iframe>' +
        '<svg><text>vector</text></svg><form action="https://example.com"><button>go</button></form>' +
        '<p><span class="hidden" onmouseover="alert(1)">plain</span></p>'
    );
    expect(el.textContent).toBe("textplain");
    expect(el.querySelectorAll("script, style, img, iframe, svg, form, button")).toHaveLength(0);
    const p = el.querySelector("p")!;
    expect(p.className).toBe("editor-paragraph-block");
    expect(p.getAttribute("style")).toBeNull();
    expect(el.querySelector("[onclick], [onmouseover], .hidden, .fixed")).toBeNull();
  });

  it("keeps the editor's alignment and colours, and nothing else from inline styles", () => {
    const el = body(
      '<p style="text-align: center; position: fixed">centred</p>' +
        '<p style="text-align: justify">justified</p>' +
        '<p><span data-text-color="peach">named</span> ' +
        '<span data-text-color="#ff0000" style="color: #ff0000; position: fixed">custom</span> ' +
        '<span data-background-color="url(x)" style="background-color: rgb(0, 0, 255); background-image: url(x)">bg</span></p>'
    );
    const [centred, justified] = el.querySelectorAll("p");
    expect(centred!.getAttribute("style")).toBe("text-align: center;");
    expect(justified!.getAttribute("style")).toBeNull();
    expect(el.querySelector('[data-text-color="peach"]')?.textContent).toBe("named");
    const custom = screen.getByText("custom");
    expect(custom.getAttribute("data-text-color")).toBeNull();
    expect(custom.getAttribute("style")).toBe("color: rgb(255, 0, 0);");
    const bg = screen.getByText("bg");
    expect(bg.getAttribute("data-background-color")).toBeNull();
    expect(bg.getAttribute("style")).toBe("background-color: rgb(0, 0, 255);");
  });

  it("doesn't turn the whitespace between blocks into blank lines", () => {
    const el = body("<p>a</p>\n  <p>b  c</p>\n<ul>\n <li><p>d</p></li>\n</ul>");
    expect(el.childNodes).toHaveLength(3);
    expect(el.querySelector("ul")!.childNodes).toHaveLength(1);
    expect(el.querySelectorAll("p")[1]!.textContent).toBe("b  c");
  });

  it("shows plain text, and nothing for an empty body", () => {
    expect(body("just text").textContent).toBe("just text");
    expect(body("").childNodes).toHaveLength(0);
  });

  it("re-renders when the message is edited", () => {
    const { container, rerender } = render(<ChatMessageBody id="b" html="<p>before</p>" />);
    rerender(<ChatMessageBody id="b" html="<p>after</p>" />);
    expect(container.textContent).toBe("after");
  });
});

describe("safeHref", () => {
  it("allows web, mail and phone links, and refuses other protocols", () => {
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeHref("tel:+441234")).toBe("tel:+441234");
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
