/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useUser } from "@/hooks/store/user";

/**
 * Keeps the workspace's chat connection open while the user is anywhere in the workspace, so unread counts stay
 * live in the sidebar. Renders nothing. Switching workspace restarts it; signing out stops it (root store reset).
 */
export const ChatConnection = observer(function ChatConnection({ workspaceSlug }: { workspaceSlug: string }) {
  const chat = useChat();
  const { data: currentUser } = useUser();
  const userId = currentUser?.id;

  useEffect(() => {
    if (userId) void chat.start(workspaceSlug, userId);
  }, [chat, workspaceSlug, userId]);

  useEffect(() => {
    const onVisibility = () => chat.setDocumentVisible(document.visibilityState === "visible");
    // Back online: don't wait out the backoff.
    const onOnline = () => chat.reconnect();
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [chat]);

  return null;
});
