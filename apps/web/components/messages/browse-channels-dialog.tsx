/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { InputField } from "@makeplane/propel/components/input-field";
import { HashOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
// hooks
import { useAppRouter } from "@/hooks/use-app-router";
import { useChat } from "@/hooks/store/use-chat";

type Props = {
  workspaceSlug: string;
  onClose: () => void;
};

/** Public channels the user can see but hasn't joined: open one to read it, or join it. */
export const BrowseChannelsDialog = observer(function BrowseChannelsDialog({ workspaceSlug, onClose }: Props) {
  const { t } = useTranslation();
  const router = useAppRouter();
  const { browsableChannels, joinChannel } = useChat();
  const [query, setQuery] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const channels = needle
    ? browsableChannels.filter((channel) => channel.name.toLowerCase().includes(needle))
    : browsableChannels;

  const open = (channelId: string) => {
    onClose();
    router.push(`/${workspaceSlug}/messages/${channelId}`);
  };

  const join = async (channelId: string) => {
    setJoining(channelId);
    try {
      await joinChannel(channelId);
      open(channelId);
    } catch {
      setToast({ type: "error", title: t("messages.errors.join_failed") });
    } finally {
      setJoining(null);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        // A join in flight opens the channel when it lands, so the dialog stays until then.
        if (!isOpen && joining === null) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("messages.browse.title")}</DialogTitle>
              <DialogDescription>{t("messages.browse.description")}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-3">
              <InputField
                id="chat-browse-search"
                name="search"
                size="lg"
                orientation="vertical"
                label={t("messages.browse.search")}
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {channels.length === 0 ? (
                <p className="py-4 text-center text-body-sm-regular text-tertiary">{t("messages.browse.empty")}</p>
              ) : (
                <ul className="flex max-h-80 flex-col overflow-y-auto">
                  {channels.map((channel) => (
                    <li
                      key={channel.id}
                      className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-layer-1-hover"
                    >
                      <HashOutline className="size-4 flex-shrink-0 text-tertiary" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body-sm-medium text-primary">{channel.name}</p>
                        <p className="truncate text-caption-md-regular text-tertiary">
                          {channel.description || t("messages.channel.member_count", { count: channel.member_count })}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        stretch="auto"
                        label={t("messages.browse.open")}
                        disabled={joining !== null}
                        onClick={() => open(channel.id)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        stretch="auto"
                        label={t("messages.channel.join")}
                        loading={joining === channel.id}
                        disabled={joining !== null}
                        onClick={() => void join(channel.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </DialogBody>
        </DialogMain>
      </DialogContent>
    </Dialog>
  );
});
