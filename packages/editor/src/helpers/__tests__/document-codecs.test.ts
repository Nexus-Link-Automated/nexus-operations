/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { generateHTML, generateJSON } from "@tiptap/html/server";
import { describe, expect, it } from "vitest";
import { createDocumentCodecs } from "../document-codecs";

const { getBinaryDataFromDocumentEditorHTMLString, getAllDocumentFormatsFromDocumentEditorBinaryData } =
  createDocumentCodecs({ generateHTML, generateJSON });

describe("getAllDocumentFormatsFromDocumentEditorBinaryData", () => {
  it.each(["R&D plan", "Use Array<T> in types", "a < b && c > d"])(
    "returns the title %j as its literal text",
    (title) => {
      const binary = getBinaryDataFromDocumentEditorHTMLString("<p>Body</p>", title);

      expect(getAllDocumentFormatsFromDocumentEditorBinaryData(binary, true).titleHTML).toBe(title);
    }
  );
});
