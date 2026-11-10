/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { setToast } from "@plane/blocks/toast";

// The instance services throw only the response body, so a signed-out request is recognised by the API's
// "not authenticated" detail rather than by its status code.
const SIGNED_OUT_DETAIL = "Authentication credentials were not provided.";

export const isSignedOutError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { detail?: unknown }).detail === SIGNED_OUT_DETAIL;

/** Tells the admin that a settings save failed, so a stopped spinner is not mistaken for a successful save. */
export const showSaveErrorToast = (error: unknown) => {
  if (isSignedOutError(error)) {
    setToast({
      type: "error",
      title: "Session expired",
      message: "Your changes were not saved. Sign in again in a new tab, then save them here.",
    });
    return;
  }
  setToast({
    type: "error",
    title: "Error",
    message: "Your changes were not saved. Please try again.",
  });
};
