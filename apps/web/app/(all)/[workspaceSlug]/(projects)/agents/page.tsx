/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { Navigate } from "react-router";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// components
import { AgentChatMovedBanner } from "@/components/agents/messages-banner";
import { AgentChatRoot } from "@/components/agents/root";
import { PageHead } from "@/components/core/page-title";
// hooks
import { useUserPermissions } from "@/hooks/store/user";

const WorkspaceAgentsPage = observer(function WorkspaceAgentsPage() {
  const { workspaceSlug } = useParams();
  const { t } = useTranslation();
  const { allowPermissions } = useUserPermissions();
  const slug = workspaceSlug?.toString();
  const canUseAgents = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE,
    slug
  );

  // Guests cannot run agents: send them home rather than to a page that can only fail.
  if (slug && !canUseAgents) return <Navigate to={`/${slug}/`} replace />;

  return (
    <>
      <PageHead title={t("agents.title")} />
      <div className="flex h-full w-full flex-col overflow-hidden">
        {slug && (
          <div className="flex-shrink-0 px-4 pt-3">
            <AgentChatMovedBanner workspaceSlug={slug} />
          </div>
        )}
        <div className="relative min-h-0 w-full flex-1 overflow-hidden">
          {slug && <AgentChatRoot workspaceSlug={slug} />}
        </div>
      </div>
    </>
  );
});

export default WorkspaceAgentsPage;
