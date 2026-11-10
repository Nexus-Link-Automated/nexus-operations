/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
import { EmptyStateCompact } from "@plane/blocks/empty-state";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { ChatChannelView } from "./channel-view";
import { ChannelSidebar } from "./channel-sidebar";
import { ChatConnectionBanner } from "./connection-banner";
import { ChatSearchPanel } from "./search";
import { ChatThreadPanel } from "./thread-panel";
import { useOpenAgentDm } from "./use-open-agent-dm";

type Props = {
  workspaceSlug: string;
  channelId?: string;
};

/** Whether the panel beside the conversation has room to stay there (Tailwind's `lg`). */
const hasRoomBeside = () => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1024px)").matches;

/**
 * The Messages page: channels and DMs on the left, the open one on the right, and beside that its open thread or the
 * search results. A thread opened from a result covers the results until it closes.
 */
export const MessagesRoot = observer(function MessagesRoot({ workspaceSlug, channelId }: Props) {
  const { t } = useTranslation();
  const chat = useChat();
  // Set when a result is opened on a narrow screen, where the results would cover it; searching again shows them.
  const [searchHidden, setSearchHidden] = useState(false);
  const searchParams = useSearchParams();
  const openAgentDm = useOpenAgentDm(workspaceSlug);
  // `?agent=<id>` (or `last`) opens that agent's conversation: the sidebar's Agents entry and the old agent page link
  // here. Followed once per link.
  const agentParam = channelId ? null : searchParams.get("agent");
  const followedAgentParam = useRef<string | null>(null);
  const started = chat.workspaceSlug === workspaceSlug;
  useEffect(() => {
    if (!started || !agentParam || followedAgentParam.current === agentParam) return;
    followedAgentParam.current = agentParam;
    void openAgentDm(agentParam === "last" ? undefined : agentParam, { replace: true });
  }, [started, agentParam, openAgentDm]);
  const thread = chat.activeThread?.channelId === channelId ? chat.activeThread : null;
  const threadChannel = thread ? chat.channelMap[thread.channelId] : undefined;
  const showSearch = !!chat.search && !searchHidden && !(thread && threadChannel);
  const searchPanel = showSearch && (
    <ChatSearchPanel
      workspaceSlug={workspaceSlug}
      channelId={channelId}
      onOpenResult={() => {
        if (!hasRoomBeside()) setSearchHidden(true);
      }}
    />
  );

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ChannelSidebar
        workspaceSlug={workspaceSlug}
        activeChannelId={channelId}
        onSearch={() => setSearchHidden(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatConnectionBanner
          status={chat.socketStatus}
          closedReason={chat.socketClosedReason}
          onReconnect={() => chat.reconnect()}
        />
        {channelId ? (
          <div className="flex min-h-0 flex-1">
            <div className={cn("flex min-h-0 min-w-0 flex-1", showSearch && "max-lg:hidden")}>
              <ChatChannelView key={channelId} workspaceSlug={workspaceSlug} channelId={channelId} />
            </div>
            {searchPanel}
            {thread && threadChannel && (
              <ChatThreadPanel
                key={thread.parentId}
                workspaceSlug={workspaceSlug}
                channel={threadChannel}
                parentId={thread.parentId}
              />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className={cn("flex flex-1 items-center justify-center", showSearch && "max-lg:hidden")}>
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
            {searchPanel}
          </div>
        )}
      </main>
    </div>
  );
});
