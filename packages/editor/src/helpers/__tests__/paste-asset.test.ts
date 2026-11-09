/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssetDuplicationHandler } from "@/helpers/asset-duplication";
import { assetDuplicationHandlers } from "@/helpers/asset-duplication";
import { processAssetDuplication } from "../paste-asset";

const IMAGE_COMPONENT = "image-component";

const originalImageHandler = assetDuplicationHandlers[IMAGE_COMPONENT];
let seenElements: Element[];

const recordElements =
  (handler: AssetDuplicationHandler): AssetDuplicationHandler =>
  (context) => {
    seenElements.push(context.element);
    return handler(context);
  };

const expectAllParsedOutsideLiveDocument = (count: number) => {
  expect(seenElements).toHaveLength(count);
  for (const element of seenElements) {
    expect(element.ownerDocument).not.toBe(document);
  }
};

beforeEach(() => {
  seenElements = [];
  assetDuplicationHandlers[IMAGE_COMPONENT] = recordElements(originalImageHandler);
});

afterEach(() => {
  assetDuplicationHandlers[IMAGE_COMPONENT] = originalImageHandler;
  delete assetDuplicationHandlers["first-component"];
  delete assetDuplicationHandlers["second-component"];
});

describe("processAssetDuplication", () => {
  it.each([
    ["a plain fragment", ""],
    ["a fragment with leading head-only tags", '<meta charset="utf-8"><title>Copied</title>'],
  ])("rewrites image components in %s using a separate document", (_label, prefix) => {
    const imageTag = '<image-component src="asset-id" id="old-id"></image-component>';

    const { processedHtml } = processAssetDuplication(`${prefix}<p>before</p>${imageTag}<p>after</p>`);

    expectAllParsedOutsideLiveDocument(1);
    expect(processedHtml).toContain(`${prefix}<p>before</p>`);
    expect(processedHtml).toContain("<p>after</p>");
    expect(processedHtml).not.toContain(imageTag);
    expect(processedHtml).toMatch(
      /<image-component src="asset-id" id="[0-9a-f-]{36}" status="duplicating"><\/image-component>/
    );
  });

  it("rewrites every image component using a separate document", () => {
    const { processedHtml } = processAssetDuplication(
      '<image-component src="first" id="a"></image-component><p><image-component src="second" id="b"></image-component></p>'
    );

    expectAllParsedOutsideLiveDocument(2);
    expect(processedHtml.match(/status="duplicating"/g)).toHaveLength(2);
  });

  it("leaves image components with remote sources unchanged using a separate document", () => {
    const html = '<image-component src="https://example.com/image.png" id="kept"></image-component>';

    expect(processAssetDuplication(html).processedHtml).toBe(html);
    expectAllParsedOutsideLiveDocument(1);
  });

  it("gives later handlers the rewritten HTML in a separate document", () => {
    assetDuplicationHandlers["first-component"] = recordElements(({ originalHtml }) => ({
      modifiedHtml: originalHtml.replaceAll("first-component", "second-component"),
      shouldProcess: true,
    }));
    assetDuplicationHandlers["second-component"] = recordElements(({ originalHtml }) => ({
      modifiedHtml: originalHtml,
      shouldProcess: false,
    }));

    processAssetDuplication('<first-component data-value="kept"></first-component>');

    expectAllParsedOutsideLiveDocument(2);
    expect(seenElements[1].nodeName).toBe("SECOND-COMPONENT");
    expect(seenElements[1].getAttribute("data-value")).toBe("kept");
  });
});
