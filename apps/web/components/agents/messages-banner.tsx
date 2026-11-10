/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { Banner } from "@makeplane/propel/components/banner";
import { Button } from "@makeplane/propel/components/button";
import { useTranslation } from "@plane/i18n";
// components
import { useOpenAgentDm } from "@/components/messages/use-open-agent-dm";
// hooks
import { useAgentChat } from "@/hooks/store/use-agent-chat";

type Props = { workspaceSlug: string };

/**
 * Chats with agents now happen in Messages, one conversation per agent. This page stays for the chats held by the
 * runner from before; the banner points to Messages.
 */
export const AgentChatMovedBanner = observer(function AgentChatMovedBanner({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const { agentId, workspaceSlug: chatWorkspace } = useAgentChat();
  const openAgentDm = useOpenAgentDm(workspaceSlug);
  const [opening, setOpening] = useState(false);
  const selected = chatWorkspace === workspaceSlug ? (agentId ?? undefined) : undefined;

  const open = async () => {
    setOpening(true);
    try {
      await openAgentDm(selected);
    } finally {
      setOpening(false);
    }
  };

  return (
    <Banner
      placement="inline"
      variant="info"
      title={t("agents.moved_to_messages.title")}
      description={t("agents.moved_to_messages.description")}
      actions={
        <Button
          variant="secondary"
          size="sm"
          stretch="auto"
          label={t("agents.moved_to_messages.open")}
          loading={opening}
          onClick={() => void open()}
        />
      }
    />
  );
});
