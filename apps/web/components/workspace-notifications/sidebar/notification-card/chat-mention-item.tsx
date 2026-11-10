/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { Avatar } from "@makeplane/propel/components/avatar";
import { Row } from "@plane/blocks/layout";
import { useTranslation } from "@plane/i18n";
import { calculateTimeAgo, cn, getFileURL } from "@plane/utils";
// components
import { chatMessagePermalink } from "@/components/messages/helpers";
import { ChatAgentAvatar } from "@/components/messages/member-avatar";
// hooks
import { useNotification } from "@/hooks/store/notifications/use-notification";
import { useAppRouter } from "@/hooks/use-app-router";
// local imports
import { NotificationOption } from "./options";

type Props = {
  workspaceSlug: string;
  notificationId: string;
};

/** An @mention in a message, or an agent's reply in its DM. Opening it marks it read and goes to the message, not to a work item peek. */
export const ChatMentionNotificationItem = observer(function ChatMentionNotificationItem({
  workspaceSlug,
  notificationId,
}: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { asJson: notification, markNotificationAsRead } = useNotification(notificationId);
  const [isSnoozeStateModalOpen, setIsSnoozeStateModalOpen] = useState(false);
  const [customSnoozeModal, setCustomSnoozeModal] = useState(false);

  const chatMessage = notification?.data?.chat_message;
  if (!chatMessage || !notification.id) return null;

  const isUnread = notification.read_at === null;
  const sender = notification.triggered_by_details;
  // An agent has no user: the entry names it itself.
  const agent = chatMessage.sender_agent;
  const name = agent
    ? (agent.name ?? t("messages.agent.removed"))
    : sender?.display_name || sender?.first_name || t("messages.unknown_member");
  const isConversation = chatMessage.channel_kind === "dm" || chatMessage.channel_kind === "group_dm";

  const open = async () => {
    if (isSnoozeStateModalOpen || customSnoozeModal) return;
    if (isUnread) await markNotificationAsRead(workspaceSlug).catch(() => undefined);
    router.push(chatMessagePermalink(workspaceSlug, chatMessage));
  };

  return (
    <Row
      className="group relative flex cursor-pointer items-center gap-2 border-b border-subtle py-4 transition-all"
      onClick={() => void open()}
    >
      {isUnread && (
        <div className="absolute top-[50%] left-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-primary" />
      )}
      <div className="relative flex w-full gap-2">
        <div className="relative flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-layer-1">
          {agent ? (
            <ChatAgentAvatar adapter={agent.adapter} size="lg" name={name} />
          ) : (
            sender && (
              <Avatar alt={name} fallback={name[0]?.toUpperCase()} src={getFileURL(sender.avatar_url)} size="xl" />
            )
          )}
        </div>
        <div className="w-full min-w-0 space-y-1">
          <div className="relative flex h-8 items-center gap-3">
            <div
              className={cn(
                "-mt-2 line-clamp-1 w-full truncate overflow-hidden break-all whitespace-normal",
                isUnread ? "text-body-xs-semibold text-primary" : "text-body-xs-regular text-secondary"
              )}
            >
              {chatMessage.channel_kind === "agent_dm"
                ? t("messages.notification.replied_in_agent_dm", { name })
                : isConversation
                  ? t("messages.notification.mentioned_in_dm", { name })
                  : t("messages.notification.mentioned_in_channel", { name, channel: chatMessage.channel_name ?? "" })}
            </div>
            <NotificationOption
              workspaceSlug={workspaceSlug}
              notificationId={notification.id}
              isSnoozeStateModalOpen={isSnoozeStateModalOpen}
              setIsSnoozeStateModalOpen={setIsSnoozeStateModalOpen}
              customSnoozeModal={customSnoozeModal}
              setCustomSnoozeModal={setCustomSnoozeModal}
            />
          </div>
          <div className="relative flex items-center gap-3 text-caption-sm-regular text-secondary">
            <div className="line-clamp-1 w-full truncate overflow-hidden break-words whitespace-normal">
              {chatMessage.preview}
            </div>
            <p className="mt-auto flex-shrink-0 text-tertiary">
              {notification.created_at && calculateTimeAgo(notification.created_at)}
            </p>
          </div>
        </div>
      </div>
    </Row>
  );
});
