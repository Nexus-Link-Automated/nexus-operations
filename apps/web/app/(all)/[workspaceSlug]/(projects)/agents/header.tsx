/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { AiStarFourOutline, PlusCircleOutline } from "@makeplane/propel/icons";
import { Breadcrumbs } from "@plane/blocks/breadcrumb";
import { Header } from "@plane/blocks/layout";
import { useTranslation } from "@plane/i18n";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { useOpenAgentDm } from "@/components/messages/use-open-agent-dm";
// hooks
import { useAgentChat } from "@/hooks/store/use-agent-chat";

export const WorkspaceAgentsHeader = observer(function WorkspaceAgentsHeader() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const slug = workspaceSlug?.toString() ?? "";
  const { agentId, workspaceSlug: chatWorkspace } = useAgentChat();
  const openAgentDm = useOpenAgentDm(slug);
  const [opening, setOpening] = useState(false);
  // A new chat now opens the agent's conversation in Messages; this page keeps the earlier chats.
  const startNewChat = async () => {
    setOpening(true);
    try {
      await openAgentDm(chatWorkspace === slug ? (agentId ?? undefined) : undefined);
    } finally {
      setOpening(false);
    }
  };

  return (
    <Header>
      <Header.LeftItem>
        <div className="flex items-center gap-2.5">
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  label={t("agents.title")}
                  icon={<AiStarFourOutline className="size-4 text-tertiary" />}
                />
              }
            />
          </Breadcrumbs>
        </div>
      </Header.LeftItem>
      <Header.RightItem>
        {slug && (
          <Button
            variant="ghost"
            size="md"
            stretch="auto"
            icon={<PlusCircleOutline />}
            label={t("agents.sessions.new")}
            loading={opening}
            onClick={() => void startNewChat()}
          />
        )}
      </Header.RightItem>
    </Header>
  );
});
