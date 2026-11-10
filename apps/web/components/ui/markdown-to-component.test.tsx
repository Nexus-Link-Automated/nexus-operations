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

describe("MarkdownRenderer GitHub-flavoured markdown", () => {
  const table = ["| Item | Points |", "| :--- | ---: |", "| Login page | 3 |", "| ~~Old API~~ | 5 |"].join("\n");

  it("renders a table with header and body cells, keeping column alignment", () => {
    const container = renderMarkdown(table);
    expect(container.textContent).not.toContain("| Item |");
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["Item", "Points"]);
    const cells = screen.getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["Login page", "3", "Old API", "5"]);
    expect(cells[1]!.style.textAlign).toBe("right");
    expect(container.querySelector("del")?.textContent).toBe("Old API");
  });

  it("still renders an image inside a table cell as a link", () => {
    const container = renderMarkdown("| Chart |\n| --- |\n| ![Build](https://example.com/b.png) |");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("cell").querySelector("a")?.getAttribute("href")).toBe("https://example.com/b.png");
  });

  it("styles second-level headings like the others", () => {
    renderMarkdown("## Summary");
    expect(screen.getByRole("heading", { level: 2, name: "Summary" }).className).toContain("text-primary");
  });
});
