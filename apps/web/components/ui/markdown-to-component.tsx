/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { createContext, useContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface CustomComponentProps {
  href: string;
  children: React.ReactNode;
}

type CustomComponent = React.ComponentType<CustomComponentProps>;

interface Props {
  markdown: string;
  components?: {
    a?: CustomComponent;
    blockquote?: CustomComponent;
    code?: CustomComponent;
    del?: CustomComponent;
    em?: CustomComponent;
    heading?: CustomComponent;
    hr?: CustomComponent;
    image?: CustomComponent;
    inlineCode?: CustomComponent;
    link?: CustomComponent;
    list?: CustomComponent;
    listItem?: CustomComponent;
    paragraph?: CustomComponent;
    strong?: CustomComponent;
    table?: CustomComponent;
    tableCell?: CustomComponent;
    tableHead?: CustomComponent;
    tableRow?: CustomComponent;
  };
  options?: any;
}

function HeadingPrimary({ children }: { children: React.ReactNode }) {
  return <h1 className="text-body-md-semibold text-primary">{children}</h1>;
}

function HeadingSection({ children }: { children: React.ReactNode }) {
  return <h2 className="text-body-sm-semibold text-primary">{children}</h2>;
}

function HeadingSecondary({ children }: { children: React.ReactNode }) {
  return <h3 className="text-body-sm-semibold text-primary">{children}</h3>;
}

function minorHeading(Tag: "h4" | "h5" | "h6") {
  return function HeadingMinor({ children }: { children: React.ReactNode }) {
    return <Tag className="text-body-xs-semibold text-primary">{children}</Tag>;
  };
}

const HeadingFour = minorHeading("h4");
const HeadingFive = minorHeading("h5");
const HeadingSix = minorHeading("h6");

function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-body-xs-regular text-secondary">{children}</p>;
}

function OrderedList({ children }: { children: React.ReactNode }) {
  return <ol className="mb-4 ml-8 list-decimal text-body-xs-regular text-secondary">{children}</ol>;
}

function UnorderedList({ children }: { children: React.ReactNode }) {
  return <ul className="mb-4 ml-8 list-disc text-body-xs-regular text-secondary">{children}</ul>;
}

function Blockquote({ children }: { children: React.ReactNode }) {
  return <blockquote className="border-l-2 border-subtle pl-3 text-secondary">{children}</blockquote>;
}

function Rule() {
  return <hr className="border-subtle" />;
}

/** Wide tables scroll on their own instead of widening the message. */
function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-max min-w-full border-collapse text-body-xs-regular text-secondary">{children}</table>
    </div>
  );
}

function TableHeaderCell({ children, style }: React.ComponentProps<"th">) {
  return (
    <th
      className="border border-subtle bg-layer-2 px-2 py-1 text-left text-body-xs-semibold text-primary"
      style={style}
    >
      {children}
    </th>
  );
}

function TableCell({ children, style }: React.ComponentProps<"td">) {
  return (
    <td className="border border-subtle px-2 py-1 align-top" style={style}>
      {children}
    </td>
  );
}

/** An image inside a link must not become a second link: anchors cannot nest. */
const InsideLinkContext = createContext(false);

function Link({ href, children }: CustomComponentProps) {
  return (
    <InsideLinkContext.Provider value={true}>
      <a href={href} className="underline hover:no-underline" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    </InsideLinkContext.Provider>
  );
}

const isWebLink = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/**
 * Markdown images become links, so the browser requests nothing until the reader clicks. The
 * markdown here is model output: an <img> would fetch whatever address the model wrote, unprompted.
 */
function ImageLink({ src, alt }: React.ComponentProps<"img">) {
  const insideLink = useContext(InsideLinkContext);
  const label = alt || src;
  if (insideLink || !isWebLink(src)) return <>{label}</>;
  return <Link href={src}>{label}</Link>;
}

export function MarkdownRenderer({ markdown, options = {} }: Props) {
  const customComponents = {
    h1: HeadingPrimary,
    h2: HeadingSection,
    h3: HeadingSecondary,
    h4: HeadingFour,
    h5: HeadingFive,
    h6: HeadingSix,
    p: Paragraph,
    ol: OrderedList,
    ul: UnorderedList,
    blockquote: Blockquote,
    hr: Rule,
    table: Table,
    th: TableHeaderCell,
    td: TableCell,
    a: Link,
    img: ImageLink,
  };

  // GitHub-flavoured markdown: tables, strikethrough, task lists and bare links, as agents write them.
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} {...options} components={customComponents}>
      {markdown}
    </ReactMarkdown>
  );
}
