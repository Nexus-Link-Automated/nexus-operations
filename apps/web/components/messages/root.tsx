/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { EmptyStateCompact } from "@plane/blocks/empty-state";
import { useTranslation } from "@plane/i18n";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { ChatChannelView } from "./channel-view";
import { ChannelSidebar } from "./channel-sidebar";
import { ChatConnectionBanner } from "./connection-banner";

type Props = {
  workspaceSlug: string;
  channelId?: string;
};

/** The Messages page: channels and DMs on the left, the open one on the right. */
export const MessagesRoot = observer(function MessagesRoot({ workspaceSlug, channelId }: Props) {
  const { t } = useTranslation();
  const chat = useChat();

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ChannelSidebar workspaceSlug={workspaceSlug} activeChannelId={channelId} />
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatConnectionBanner
          status={chat.socketStatus}
          closedReason={chat.socketClosedReason}
          onReconnect={() => chat.reconnect()}
        />
        {channelId ? (
          <ChatChannelView key={channelId} workspaceSlug={workspaceSlug} channelId={channelId} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyStateCompact
              assetKey="comment"
              title={chat.channelsError ? t("messages.errors.load_channels_failed") : t("messages.empty.title")}
              description={t("messages.empty.description")}
              align="center"
              actions={
                chat.channelsError
                  ? [
                      {
                        label: t("messages.errors.retry"),
                        variant: "secondary",
                        onClick: () => void chat.fetchChannels(),
                      },
                    ]
                  : undefined
              }
            />
          </div>
        )}
      </main>
    </div>
  );
});
