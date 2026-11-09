/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useTranslation } from "@plane/i18n";
// components
import { PageHead } from "@/components/core/page-title";
import { MessagesRoot } from "@/components/messages/root";

const WorkspaceMessagesPage = observer(function WorkspaceMessagesPage() {
  const { workspaceSlug } = useParams();
  const { t } = useTranslation();
  const slug = workspaceSlug?.toString();

  return (
    <>
      <PageHead title={t("messages.title")} />
      <div className="relative h-full w-full overflow-hidden">{slug && <MessagesRoot workspaceSlug={slug} />}</div>
    </>
  );
});

export default WorkspaceMessagesPage;
