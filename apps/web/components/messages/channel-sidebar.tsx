/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { IconButton } from "@makeplane/propel/components/icon-button";
import { AddOutline, HashOutline, LockOutline, SearchOutline, UserCogOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import type { TChatChannel } from "@plane/types";
import { cn } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
// local imports
import { AgentPickerDialog } from "./agent-picker-dialog";
import { BrowseChannelsDialog } from "./browse-channels-dialog";
import { CreateChannelDialog } from "./create-channel-dialog";
import { GuestDmAccessDialog } from "./guest-dm-access-dialog";
import { channelDisplayName, otherMemberIds } from "./helpers";
import { ChatAgentAvatar, MemberAvatar } from "./member-avatar";
import { NewDirectMessageDialog } from "./new-dm-dialog";
import { ChatSearchBox } from "./search";
import { ChatUnreadCount } from "./unread-badge";

type Props = {
  workspaceSlug: string;
  activeChannelId: string | undefined;
  /** A search was started or its box focused: show the results. */
  onSearch?: () => void;
};

export const ChannelSidebar = observer(function ChannelSidebar({ workspaceSlug, activeChannelId, onSearch }: Props) {
  const { t } = useTranslation();
  const { joinedChannels, directMessages, agentDms, me, channelsLoaded } = useChat();
  const [dialog, setDialog] = useState<"create" | "browse" | "dm" | "guests" | "agent" | null>(null);
  const canOpenAgentDms = !!me?.can_open_agent_dms;

  return (
    <nav
      aria-label={t("messages.title")}
      className="flex h-full w-64 flex-shrink-0 flex-col overflow-y-auto border-r border-subtle bg-layer-1 py-3"
    >
      <ChatSearchBox onSearch={() => onSearch?.()} />
      <Section
        title={t("messages.channels.title")}
        actions={
          <>
            <IconButton
              variant="ghost"
              size="sm"
              icon={<SearchOutline />}
              aria-label={t("messages.channels.browse")}
              onClick={() => setDialog("browse")}
            />
            {me?.can_create_channels !== false && (
              <IconButton
                variant="ghost"
                size="sm"
                icon={<AddOutline />}
                aria-label={t("messages.channels.create")}
                onClick={() => setDialog("create")}
              />
            )}
          </>
        }
      >
        {channelsLoaded && joinedChannels.length === 0 && (
          <p className="px-4 py-1 text-caption-md-regular text-tertiary">{t("messages.channels.none")}</p>
        )}
        {joinedChannels.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            workspaceSlug={workspaceSlug}
            active={channel.id === activeChannelId}
          />
        ))}
      </Section>

      <Section
        title={t("messages.dms.title")}
        actions={
          <>
            {me?.is_workspace_admin && (
              <IconButton
                variant="ghost"
                size="sm"
                icon={<UserCogOutline />}
                aria-label={t("messages.guest_access.open")}
                onClick={() => setDialog("guests")}
              />
            )}
            {me?.can_open_dms !== false && (
              <IconButton
                variant="ghost"
                size="sm"
                icon={<AddOutline />}
                aria-label={t("messages.dms.new")}
                onClick={() => setDialog("dm")}
              />
            )}
          </>
        }
      >
        {channelsLoaded && directMessages.length === 0 && (
          <p className="px-4 py-1 text-caption-md-regular text-tertiary">{t("messages.dms.none")}</p>
        )}
        {directMessages.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            workspaceSlug={workspaceSlug}
            active={channel.id === activeChannelId}
          />
        ))}
      </Section>

      {(canOpenAgentDms || agentDms.length > 0) && (
        <Section
          title={t("messages.agent_dms.title")}
          actions={
            canOpenAgentDms && (
              <IconButton
                variant="ghost"
                size="sm"
                icon={<AddOutline />}
                aria-label={t("messages.agent_dms.new")}
                onClick={() => setDialog("agent")}
              />
            )
          }
        >
          {channelsLoaded && agentDms.length === 0 && (
            <p className="px-4 py-1 text-caption-md-regular text-tertiary">{t("messages.agent_dms.none")}</p>
          )}
          {agentDms.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              workspaceSlug={workspaceSlug}
              active={channel.id === activeChannelId}
            />
          ))}
        </Section>
      )}

      {dialog === "create" && <CreateChannelDialog workspaceSlug={workspaceSlug} onClose={() => setDialog(null)} />}
      {dialog === "browse" && <BrowseChannelsDialog workspaceSlug={workspaceSlug} onClose={() => setDialog(null)} />}
      {dialog === "dm" && <NewDirectMessageDialog workspaceSlug={workspaceSlug} onClose={() => setDialog(null)} />}
      {dialog === "guests" && <GuestDmAccessDialog workspaceSlug={workspaceSlug} onClose={() => setDialog(null)} />}
      {dialog === "agent" && <AgentPickerDialog workspaceSlug={workspaceSlug} onClose={() => setDialog(null)} />}
    </nav>
  );
});

function Section({ title, actions, children }: { title: string; actions: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4 flex flex-col gap-px">
      <div className="flex items-center justify-between px-4 pb-1">
        <h2 className="text-caption-md-medium text-tertiary">{title}</h2>
        <div className="flex items-center gap-0.5">{actions}</div>
      </div>
      {children}
    </section>
  );
}

type RowProps = {
  channel: TChatChannel;
  workspaceSlug: string;
  active: boolean;
};

/** One channel or DM: its icon (or the other person's avatar), name and unread count. */
export const ChannelRow = observer(function ChannelRow({ channel, workspaceSlug, active }: RowProps) {
  const { t } = useTranslation();
  const { userId } = useChat();
  const { getUserDetails } = useMember();
  const name = channelDisplayName(
    channel,
    userId,
    (id) => getUserDetails(id)?.display_name,
    t("messages.unknown_member"),
    t("messages.agent.removed")
  );
  const unread = channel.is_member ? channel.unread_count : 0;
  const isDm = channel.kind === "dm" || channel.kind === "group_dm";
  const firstOther = isDm ? otherMemberIds(channel, userId)[0] : undefined;

  return (
    <Link
      href={`/${workspaceSlug}/messages/${channel.id}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-body-sm-regular text-secondary hover:bg-layer-transparent-hover",
        {
          "bg-layer-transparent-selected text-primary": active,
          "text-body-sm-semibold text-primary": unread > 0,
        }
      )}
    >
      {channel.kind === "agent_dm" ? (
        <ChatAgentAvatar adapter={channel.agent_dm?.agent?.adapter ?? null} size="sm" />
      ) : isDm ? (
        <MemberAvatar userId={firstOther} size="sm" />
      ) : channel.kind === "private" ? (
        <LockOutline className="size-4 flex-shrink-0 text-tertiary" aria-hidden />
      ) : (
        <HashOutline className="size-4 flex-shrink-0 text-tertiary" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <ChatUnreadCount count={unread} />
    </Link>
  );
});
