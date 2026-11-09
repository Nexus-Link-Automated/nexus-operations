/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { createContext, useContext } from "react";
import ReactMarkdown from "react-markdown";

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

function HeadingSecondary({ children }: { children: React.ReactNode }) {
  return <h3 className="text-body-sm-semibold text-primary">{children}</h3>;
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-body-xs-regular text-secondary">{children}</p>;
}

function OrderedList({ children }: { children: React.ReactNode }) {
  return <ol className="mb-4 ml-8 list-decimal text-body-xs-regular text-secondary">{children}</ol>;
}

function UnorderedList({ children }: { children: React.ReactNode }) {
  return <ul className="mb-4 ml-8 list-disc text-body-xs-regular text-secondary">{children}</ul>;
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
    h3: HeadingSecondary,
    p: Paragraph,
    ol: OrderedList,
    ul: UnorderedList,
    a: Link,
    img: ImageLink,
  };

  return (
    <ReactMarkdown {...options} components={customComponents}>
      {markdown}
    </ReactMarkdown>
  );
}
