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

/** What counts as the user being here. A tab left in front of nobody fires none of these. */
const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;
const ACTIVITY_LISTENER: AddEventListenerOptions = { capture: true, passive: true };

/**
 * Keeps the workspace's chat connection open while the user is anywhere in the workspace, so unread counts stay
 * live in the sidebar. A hidden tab closes it after a long idle spell and reopens it when they come back. Renders
 * nothing.
 * Switching workspace restarts it; signing out stops it (root store reset).
 */
export const ChatConnection = observer(function ChatConnection({ workspaceSlug }: { workspaceSlug: string }) {
  const chat = useChat();
  const { data: currentUser } = useUser();
  const userId = currentUser?.id;

  useEffect(() => {
    if (userId) void chat.start(workspaceSlug, userId);
  }, [chat, workspaceSlug, userId]);

  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      chat.setDocumentVisible(visible);
      if (visible) chat.noteActivity();
    };
    const onActivity = () => chat.noteActivity();
    // Back online: don't wait out the backoff.
    const onOnline = () => chat.reconnect();
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    // Capture, so a component that stops propagation can't hide activity from the idle clock.
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, ACTIVITY_LISTENER);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, ACTIVITY_LISTENER);
    };
  }, [chat]);

  return null;
});
