/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { ArchiveOutline, HashOutline, LockOutline, MembersOutline, SettingsOutline } from "@makeplane/propel/icons";
import { EmptyStateCompact } from "@plane/blocks/empty-state";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { ChatServiceError } from "@plane/services";
import type { TChatChannel } from "@plane/types";
import { cn } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
import { useAppRouter } from "@/hooks/use-app-router";
// local imports
import { ChannelMembersDialog } from "./channel-members-dialog";
import { ChannelProjectBadge, ChannelSettingsDialog } from "./channel-project";
import type { TChatComposerBody } from "./composer";
import { ChatComposer } from "./composer";
import { channelDisplayName } from "./helpers";
import { ChatMessageList } from "./message-list";

type Props = {
  workspaceSlug: string;
  channelId: string;
};

/**
 * One channel or DM: its header, its messages, and the composer (or a Join bar for a channel the user isn't in). The
 * open thread sits beside it (see `MessagesRoot`). A link to a reply, `?message=<thread>&reply=<reply>`, opens it.
 */
export const ChatChannelView = observer(function ChatChannelView({ workspaceSlug, channelId }: Props) {
  const { t } = useTranslation();
  const chat = useChat();
  const { getUserDetails } = useMember();
  const router = useAppRouter();
  const [notFound, setNotFound] = useState(false);
  const [joining, setJoining] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const channel = chat.channelMap[channelId];
  const started = chat.workspaceSlug === workspaceSlug;
  const searchParams = useSearchParams();
  const linkedThreadId = searchParams.get("reply") ? searchParams.get("message") : null;
  // A channel that was shown and then went away: the user lost access (removed, or a private channel left).
  // The view is keyed by channel, so this starts over for each one.
  const [wasShown, setWasShown] = useState(false);
  const isShown = !!channel;
  useEffect(() => {
    if (isShown) setWasShown(true);
  }, [isShown]);

  useEffect(() => {
    if (!started) return;
    setNotFound(false);
    chat.openChannel(channelId).catch((error: unknown) => {
      if (error instanceof ChatServiceError && error.isNotFound) setNotFound(true);
    });
    return () => chat.closeChannel();
  }, [chat, channelId, started]);

  useEffect(() => {
    if (started && linkedThreadId) void chat.openThread(channelId, linkedThreadId);
  }, [chat, channelId, started, linkedThreadId]);

  if (notFound || (wasShown && !channel)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyStateCompact
          assetKey="comment"
          title={t("messages.channel.not_found_title")}
          description={t("messages.channel.not_found_description")}
          align="center"
        />
      </div>
    );
  }
  if (!channel) return <div className="flex-1" />;

  const name = channelDisplayName(
    channel,
    chat.userId,
    (id) => getUserDetails(id)?.display_name,
    t("messages.unknown_member")
  );
  const isNamed = channel.kind === "public" || channel.kind === "private";
  const archived = !!channel.archived_at;
  // The API lets channel admins and workspace admins change a channel (`is_channel_admin`).
  const canManage = isNamed && !archived && (channel.my_role === "admin" || !!chat.me?.is_workspace_admin);

  const join = async () => {
    setJoining(true);
    try {
      await chat.joinChannel(channel.id);
      await chat.markRead(channel.id);
    } catch {
      setToast({ type: "error", title: t("messages.errors.join_failed") });
    } finally {
      setJoining(false);
    }
  };

  const leave = async () => {
    try {
      await chat.leaveChannel(channel.id);
      // A private channel can't be read from outside, so there's nothing left to show here.
      if (channel.kind === "private") router.push(`/${workspaceSlug}/messages`);
    } catch (error) {
      setToast({
        type: "error",
        title: t("messages.errors.leave_failed"),
        message: error instanceof ChatServiceError ? (error.message ?? undefined) : undefined,
      });
    }
  };

  const send = (body: TChatComposerBody) => {
    chat.sendMessage(channel.id, body).catch(() => {
      // The message stays in the list as failed, with retry and discard.
    });
  };

  return (
    // Below `lg` an open thread takes the conversation's place: beside it, neither would have room.
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        chat.activeThread?.channelId === channel.id && "max-lg:hidden"
      )}
    >
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-subtle px-4 py-2.5">
        <ChannelIcon channel={channel} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body-md-semibold text-primary">{name}</h1>
          {isNamed && (
            <p className="truncate text-caption-md-regular text-tertiary">
              {channel.description || t("messages.channel.member_count", { count: channel.member_count })}
            </p>
          )}
        </div>
        {isNamed && channel.project && <ChannelProjectBadge projectId={channel.project} />}
        {isNamed && (
          <IconButton
            variant="ghost"
            size="sm"
            icon={<MembersOutline />}
            aria-label={t("messages.members.open")}
            onClick={() => setShowMembers(true)}
          />
        )}
        {canManage && (
          <IconButton
            variant="ghost"
            size="sm"
            icon={<SettingsOutline />}
            aria-label={t("messages.channel_settings.title")}
            onClick={() => setSettingsOpen(true)}
          />
        )}
        {isNamed && channel.is_member && !archived && (
          <Button
            variant="ghost"
            size="sm"
            stretch="auto"
            label={t("messages.channel.leave")}
            onClick={() => void leave()}
          />
        )}
      </header>
      {showMembers && (
        <ChannelMembersDialog workspaceSlug={workspaceSlug} channel={channel} onClose={() => setShowMembers(false)} />
      )}
      {settingsOpen && (
        <ChannelSettingsDialog workspaceSlug={workspaceSlug} channel={channel} onClose={() => setSettingsOpen(false)} />
      )}

      <ChatMessageList
        workspaceSlug={workspaceSlug}
        channelId={channel.id}
        intro={
          <div className="flex flex-col gap-1">
            <p className="text-body-md-semibold text-primary">
              {isNamed ? t("messages.channel.intro_title", { name }) : t("messages.dm.intro_title", { name })}
            </p>
            <p className="text-body-sm-regular text-tertiary">
              {isNamed
                ? channel.description || t("messages.channel.intro_description")
                : t("messages.dm.intro_description")}
            </p>
          </div>
        }
      />

      <div className="flex-shrink-0 px-4 pb-4">
        {archived ? (
          <div className="flex items-center gap-2 rounded-md bg-layer-2 px-3 py-2 text-body-sm-regular text-secondary">
            <ArchiveOutline className="size-4 flex-shrink-0" aria-hidden />
            {t("messages.channel.archived")}
          </div>
        ) : channel.is_member ? (
          <ChatComposer
            workspaceSlug={workspaceSlug}
            channelId={channel.id}
            placeholder={
              isNamed
                ? t("messages.composer.placeholder_channel", { name })
                : t("messages.composer.placeholder_dm", { name })
            }
            onSend={send}
          />
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md bg-layer-2 px-3 py-2">
            <span className="text-body-sm-regular text-secondary">{t("messages.channel.join_prompt", { name })}</span>
            <Button
              variant="primary"
              size="sm"
              stretch="auto"
              label={t("messages.channel.join")}
              loading={joining}
              onClick={() => void join()}
            />
          </div>
        )}
      </div>
    </div>
  );
});

function ChannelIcon({ channel }: { channel: TChatChannel }) {
  if (channel.kind === "private") return <LockOutline className="size-4 flex-shrink-0 text-tertiary" aria-hidden />;
  if (channel.kind === "public") return <HashOutline className="size-4 flex-shrink-0 text-tertiary" aria-hidden />;
  return null;
}
