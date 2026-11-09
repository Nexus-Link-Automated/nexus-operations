/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { unreadLabel } from "./helpers";

type Props = {
  count: number;
  className?: string;
};

/** A count of unread messages; renders nothing at zero. */
export function ChatUnreadCount({ count, className }: Props) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto inline-flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent-primary px-1 text-caption-sm-semibold text-on-color",
        className
      )}
      aria-label={t("messages.unread_count", { count })}
    >
      {unreadLabel(count)}
    </span>
  );
}

/** Every unread message in the workspace, for the Messages sidebar item. */
export const MessagesSidebarBadge = observer(function MessagesSidebarBadge() {
  const { totalUnread } = useChat();
  return <ChatUnreadCount count={totalUnread} />;
});
