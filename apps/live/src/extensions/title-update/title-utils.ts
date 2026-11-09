/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type * as Y from "yjs";

/**
 * Reads a page title from its Yjs fragment as the literal text the user typed.
 * Titles are plain text: passing them through an HTML parser or sanitizer would encode "&" and
 * drop anything that looks like a tag, such as the "<T>" in "Array<T>".
 */
export const getTitleText = (title: Y.XmlFragment): string => {
  const textNodes = Array.from(title.createTreeWalker((node) => "toDelta" in node)) as Y.XmlText[];
  return textNodes
    .flatMap((node) => node.toDelta() as { insert?: unknown }[])
    .map(({ insert }) => (typeof insert === "string" ? insert : ""))
    .join("")
    .trim();
};
