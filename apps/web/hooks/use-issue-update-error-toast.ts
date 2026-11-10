/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";

/**
 * For inline work item edits (list, board and spreadsheet rows). The store puts the old value back when a
 * save fails, so without a toast the change silently snaps back and the user may think it was saved.
 */
export const useIssueUpdateErrorToast = (isEpic = false) => {
  const { t } = useTranslation();

  return useCallback(
    async (update: () => Promise<unknown> | undefined) => {
      try {
        await update();
      } catch {
        setToast({
          type: "error",
          title: t("toast.error"),
          message: t("entity.update.failed", { entity: isEpic ? t("common.epic") : t("issue.label", { count: 1 }) }),
        });
      }
    },
    [t, isEpic]
  );
};
