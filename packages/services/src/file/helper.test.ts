/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { getFileMetaDataForUpload } from "./helper";

const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);

const detectedType = async (content: BlobPart, name: string, browserType: string): Promise<string> => {
  const { type } = await getFileMetaDataForUpload(new File([content], name, { type: browserType }));
  return type;
};

describe("getFileMetaDataForUpload", () => {
  it.each([
    ["notes.txt", "plain text", "text/plain"],
    ["data.csv", "a,b\n1,2\n", "text/csv"],
    ["README.md", "# Title\n", "text/markdown"],
    ["CHANGELOG.MARKDOWN", "# Title\n", "text/markdown"],
    ["config.json", '{"key":"value"}', "application/json"],
    ["logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "image/svg+xml"],
  ])("identifies %s by its extension when the browser reports no type", async (name, content, expected) => {
    await expect(detectedType(content, name, "")).resolves.toBe(expected);
  });

  it.each([
    ["notes.log", "text/plain"],
    ["config.json", "application/json"],
    ["logo.svg", "image/svg+xml"],
  ])("uses the type the browser reports for %s", async (name, browserType) => {
    await expect(detectedType("no binary signature", name, browserType)).resolves.toBe(browserType);
  });

  it("prefers the signature, then the browser's type, then the extension", async () => {
    await expect(detectedType(GIF_BYTES, "notes.txt", "text/plain")).resolves.toBe("image/gif");
    await expect(detectedType("a,b", "report.csv", "application/vnd.ms-excel")).resolves.toBe(
      "application/vnd.ms-excel"
    );
    await expect(detectedType("a,b", "report.csv", "")).resolves.toBe("text/csv");
  });

  it("leaves types the API does not allow for the API to refuse", async () => {
    await expect(detectedType("<html></html>", "page.html", "text/html")).resolves.toBe("text/html");
    await expect(detectedType("anything", "mystery.xyz", "")).resolves.toBe("");
    await expect(detectedType("anything", "file.constructor", "")).resolves.toBe("");
  });

  it("does not take the browser's word for a raster image that has no signature", async () => {
    await expect(detectedType("plain text", "notes.txt", "text/plain")).resolves.toBe("text/plain");
    const types = await Promise.all(
      [
        ["photo.png", "image/png"],
        ["photo.jpg", "image/jpeg"],
        ["photo.gif", "image/gif"],
        ["photo.webp", "image/webp"],
      ].map(([name, browserType]) => detectedType("not an image", name ?? "", browserType ?? ""))
    );
    expect(types).toEqual(["", "", "", ""]);
  });
});
