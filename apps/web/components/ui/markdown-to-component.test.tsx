/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./markdown-to-component";

function renderMarkdown(markdown: string, options?: Record<string, unknown>) {
  return render(<MarkdownRenderer markdown={markdown} {...(options ? { options } : {})} />).container;
}

describe("MarkdownRenderer images", () => {
  it("renders an image as a link showing its alt text, and loads nothing", () => {
    const container = renderMarkdown("![Build chart](https://example.com/chart.png)");
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "Build chart" });
    expect(link.getAttribute("href")).toBe("https://example.com/chart.png");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("handles reference-style images the same way", () => {
    const container = renderMarkdown("![Build chart][chart]\n\n[chart]: https://example.com/chart.png");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Build chart" }).getAttribute("href")).toBe(
      "https://example.com/chart.png"
    );
  });

  it("uses the address as the link text when the image has no alt text", () => {
    renderMarkdown("![](http://example.com/chart.png)");
    expect(screen.getByRole("link", { name: "http://example.com/chart.png" })).toBeTruthy();
  });

  it.each([
    ["a relative path", "![Chart](chart.png)"],
    ["a protocol-relative address", "![Chart](//example.com/chart.png)"],
    ["a data URL", "![Chart](data:image/png;base64,AAAA)"],
    ["a script URL", "![Chart](javascript:void)"],
  ])("shows the alt text without a link for %s", (_name, markdown) => {
    const container = renderMarkdown(markdown);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Chart");
  });

  it("keeps the outer link when an image is wrapped in one, without nesting anchors", () => {
    const container = renderMarkdown("[![Status](https://example.com/badge.svg)](https://example.com/build)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Status" }).getAttribute("href")).toBe("https://example.com/build");
  });

  it("does not create an image from raw HTML", () => {
    const container = renderMarkdown('<img src="https://example.com/chart.png">');
    expect(container.querySelector("img")).toBeNull();
  });

  it("cannot be given a component that renders images again", () => {
    const options = { components: { img: () => <img src="https://example.com/chart.png" alt="" /> } };
    const container = renderMarkdown("![Chart](https://example.com/chart.png)", options);
    expect(container.querySelector("img")).toBeNull();
  });

  it("leaves ordinary links alone", () => {
    renderMarkdown("[Docs](https://example.com/docs)");
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
