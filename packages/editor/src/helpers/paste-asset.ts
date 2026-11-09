/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { assetDuplicationHandlers } from "@/helpers/asset-duplication";

// Utility function to process HTML content with all registered handlers
export const processAssetDuplication = (htmlContent: string): { processedHtml: string } => {
  // Parsed into a separate document so that nothing in the pasted HTML loads or runs.
  const parser = new DOMParser();
  let parsedDocument = parser.parseFromString(htmlContent, "text/html");

  let processedHtml = htmlContent;

  // Process each registered component type
  for (const [componentName, handler] of Object.entries(assetDuplicationHandlers)) {
    const elements = parsedDocument.querySelectorAll(componentName);

    if (elements.length > 0) {
      elements.forEach((element) => {
        const result = handler({ element, originalHtml: processedHtml });
        if (result.shouldProcess) {
          processedHtml = result.modifiedHtml;
        }
      });

      // Parse the processed HTML again for the next iteration
      parsedDocument = parser.parseFromString(processedHtml, "text/html");
    }
  }

  return { processedHtml };
};
