/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { EmptyStateCompact } from "@plane/blocks/empty-state";
import { useTranslation } from "@plane/i18n";
// components
import { PageHead } from "@/components/core/page-title";

const WorkspaceMessagesPage = observer(function WorkspaceMessagesPage() {
  const { t } = useTranslation();

  return (
    <>
      <PageHead title={t("messages.title")} />
      <div className="flex h-full w-full items-center justify-center">
        <EmptyStateCompact
          assetKey="comment"
          title={t("messages.empty.title")}
          description={t("messages.empty.description")}
          align="center"
        />
      </div>
    </>
  );
});

export default WorkspaceMessagesPage;
