/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createElement, Fragment, useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
// plane imports
import type { TSearchEntities } from "@plane/types";
// components
import { EditorMentionsRoot } from "@/components/editor/embeds/mentions";

/*
 * A message body is HTML from Plane's lite editor. Mounting a read-only editor for every message made each one a
 * full ProseMirror view, so a long history got slow to scroll back through. This renders the same HTML as plain
 * elements instead, with the classes the editor gives each node so its styles still apply.
 *
 * Only what is listed here is rendered, built as React elements from parsed HTML: other tags are dropped or reduced
 * to their text, and no attribute is copied as it is. Classes, styles and event handlers in the HTML never reach the
 * page, and links keep only safe protocols.
 */

const CLASSES = {
  paragraph: "editor-paragraph-block",
  heading: "editor-heading-block",
  bulletList: "list-disc pl-7 space-y-(--list-spacing-y)",
  orderedList: "list-decimal pl-7 space-y-(--list-spacing-y)",
  listItem: "not-prose space-y-2",
  taskList: "not-prose pl-2 space-y-2",
  taskItem: "relative",
  codeBlock: "my-2 rounded-lg bg-layer-3 p-4 text-primary",
  codeInline:
    "rounded-sm bg-layer-3 px-[6px] py-[1.5px] font-code font-medium text-(--extended-color-orange-600) border-[0.5px] border-subtle",
  link: "text-accent-secondary underline underline-offset-[3px] hover:text-accent-primary transition-colors cursor-pointer",
  horizontalRule: "py-4 border-strong-1",
};

/** Tags rendered as themselves, with no attributes. */
const PLAIN_TAGS: Record<string, string> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  u: "u",
  s: "s",
  del: "s",
  strike: "s",
  blockquote: "blockquote",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  tfoot: "tfoot",
  tr: "tr",
};

/** Tags dropped with everything in them: their text isn't message text. */
const DROPPED_TAGS = new Set([
  "audio",
  "button",
  "canvas",
  "embed",
  "head",
  "iframe",
  "image-component",
  "img",
  "input",
  "math",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "video",
]);

/** Elements whose whitespace-only text is formatting between blocks, not content. */
const BLOCK_CONTAINERS = new Set([
  "blockquote",
  "body",
  "div",
  "li",
  "ol",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const ALIGNMENTS = new Set(["left", "center", "right"]);
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
/** The editor's named colours are applied by its stylesheet from these attributes. */
const COLOR_KEY = /^[a-z][a-z-]*$/;

/** The link's address if it is safe to follow, resolved against this page for a relative one. */
export function safeHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function alignment(element: HTMLElement): CSSProperties | undefined {
  const textAlign = element.style.textAlign;
  return ALIGNMENTS.has(textAlign) ? { textAlign: textAlign as CSSProperties["textAlign"] } : undefined;
}

function cellSpan(element: Element, name: "colspan" | "rowspan"): number | undefined {
  const value = Number(element.getAttribute(name));
  return Number.isInteger(value) && value > 1 && value <= 100 ? value : undefined;
}

/**
 * Text colour and highlight, as the editor's colour mark writes them: a named colour as a data attribute, any other
 * as an inline style. Read back through the browser's CSS parser, one property each, so nothing else can come along.
 */
function colorProps(element: HTMLElement): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const style: CSSProperties = {};
  const text = element.getAttribute("data-text-color");
  const background = element.getAttribute("data-background-color");
  if (text && COLOR_KEY.test(text)) props["data-text-color"] = text;
  else if (element.style.color) style.color = element.style.color;
  if (background && COLOR_KEY.test(background)) props["data-background-color"] = background;
  else if (element.style.backgroundColor) style.backgroundColor = element.style.backgroundColor;
  if (Object.keys(style).length) props.style = style;
  return props;
}

function renderChildren(parent: Element, inCode: boolean): ReactNode[] {
  const skipBlankText = BLOCK_CONTAINERS.has(parent.localName);
  const children: ReactNode[] = [];
  parent.childNodes.forEach((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      if (!(skipBlankText && !text.trim())) children.push(text);
      return;
    }
    if (child.nodeType === Node.ELEMENT_NODE) children.push(renderElement(child as HTMLElement, index, inCode));
  });
  return children;
}

function renderTaskItem(element: HTMLElement, key: number): ReactNode {
  const checked = element.getAttribute("data-checked") === "true";
  // The editor writes the item's content in a div after the checkbox's label.
  const content = [...element.children].find((child) => child.localName === "div");
  const label = content?.textContent?.trim() || undefined;
  return (
    <li key={key} data-type="taskItem" data-checked={checked} className={CLASSES.taskItem}>
      {/* oxlint-disable-next-line jsx-a11y/label-has-associated-control -- here for the editor's styles; the checkbox has its own name */}
      <label>
        <input type="checkbox" checked={checked} disabled readOnly aria-label={label} />
        <span />
      </label>
      <div>{content ? renderChildren(content, false) : null}</div>
    </li>
  );
}

function renderHorizontalRule(key: number): ReactNode {
  return (
    <div key={key} data-type="horizontalRule" className={CLASSES.horizontalRule}>
      <div />
    </div>
  );
}

function renderElement(element: HTMLElement, key: number, inCode: boolean): ReactNode {
  const tag = element.localName;
  if (DROPPED_TAGS.has(tag)) return null;
  if (PLAIN_TAGS[tag]) return createElement(PLAIN_TAGS[tag], { key }, ...renderChildren(element, inCode));
  if (HEADINGS.has(tag)) {
    return createElement(
      tag,
      { key, className: CLASSES.heading, style: alignment(element) },
      ...renderChildren(element, inCode)
    );
  }

  switch (tag) {
    case "p":
      return (
        <p key={key} className={CLASSES.paragraph} style={alignment(element)}>
          {renderChildren(element, inCode)}
        </p>
      );
    case "br":
      return <br key={key} />;
    case "ul":
      return element.getAttribute("data-type") === "taskList" ? (
        <ul key={key} data-type="taskList" className={CLASSES.taskList}>
          {renderChildren(element, inCode)}
        </ul>
      ) : (
        <ul key={key} className={CLASSES.bulletList}>
          {renderChildren(element, inCode)}
        </ul>
      );
    case "ol": {
      const start = Number(element.getAttribute("start"));
      return (
        <ol key={key} className={CLASSES.orderedList} start={Number.isInteger(start) ? start : undefined}>
          {renderChildren(element, inCode)}
        </ol>
      );
    }
    case "li":
      if (element.getAttribute("data-type") === "taskItem") return renderTaskItem(element, key);
      return (
        <li key={key} className={CLASSES.listItem}>
          {renderChildren(element, inCode)}
        </li>
      );
    case "pre":
      return (
        <pre key={key} className={CLASSES.codeBlock}>
          {renderChildren(element, true)}
        </pre>
      );
    case "code":
      return (
        <code key={key} className={inCode ? "whitespace-pre-wrap" : CLASSES.codeInline} spellCheck={false}>
          {renderChildren(element, inCode)}
        </code>
      );
    case "a": {
      const href = safeHref(element.getAttribute("href"));
      if (!href) return <Fragment key={key}>{renderChildren(element, inCode)}</Fragment>;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className={CLASSES.link}>
          {renderChildren(element, inCode)}
        </a>
      );
    }
    case "div":
      // The editor writes its divider as a div.
      if (element.getAttribute("data-type") === "horizontalRule") return renderHorizontalRule(key);
      return <div key={key}>{renderChildren(element, inCode)}</div>;
    case "hr":
      return renderHorizontalRule(key);
    case "th":
    case "td":
      return createElement(
        tag,
        { key, colSpan: cellSpan(element, "colspan"), rowSpan: cellSpan(element, "rowspan") },
        ...renderChildren(element, inCode)
      );
    case "mention-component":
      return (
        <EditorMentionsRoot
          key={key}
          entity_identifier={element.getAttribute("entity_identifier") ?? ""}
          entity_name={element.getAttribute("entity_name") as TSearchEntities}
        />
      );
    case "span": {
      if (element.getAttribute("data-type") === "emoji") {
        return (
          <span key={key} data-type="emoji" data-name={element.getAttribute("data-name") ?? undefined}>
            {renderChildren(element, inCode)}
          </span>
        );
      }
      const props = colorProps(element);
      if (!Object.keys(props).length) return <Fragment key={key}>{renderChildren(element, inCode)}</Fragment>;
      return createElement("span", { key, ...props }, ...renderChildren(element, inCode));
    }
    default:
      // Anything else the editor doesn't know: it would keep only the text.
      return <Fragment key={key}>{renderChildren(element, inCode)}</Fragment>;
  }
}

/** The elements to show for a message body's HTML. */
export function renderMessageHtml(html: string): ReactNode[] {
  if (!html) return [];
  const { body } = new DOMParser().parseFromString(html, "text/html");
  return renderChildren(body, false);
}

type Props = { id: string; html: string };

/** A message body, read-only, laid out as the lite editor lays it out. */
export function ChatMessageBody({ id, html }: Props) {
  const content = useMemo(() => renderMessageHtml(html), [html]);
  return (
    <div className="editor-container line-spacing-regular small-font sans-serif w-full max-w-full">
      <div id={id} className="ProseMirror prose-brand prose-headings:font-display font-default max-w-full prose">
        {content}
      </div>
    </div>
  );
}
