/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// local imports
import { unreadLabel } from "./helpers";

/**
 * Puts `(count)` in front of the tab's title while `count` is above zero, whatever title the page sets meanwhile, and
 * puts the page's own title back when it drops to zero or the component goes.
 */
export function useUnreadTitle(count: number): void {
  useEffect(() => {
    if (count <= 0) return;
    const prefix = `(${unreadLabel(count)}) `;
    let base = document.title;
    let written = "";
    const apply = () => {
      // Anything but what was written here is the page's new title.
      if (document.title === written) return;
      base = document.title;
      written = `${prefix}${base}`;
      document.title = written;
    };
    apply();
    // Pages set the title themselves (`PageHead`, route meta), so put the count back whenever one does.
    const watcher = new MutationObserver(apply);
    watcher.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      watcher.disconnect();
      if (document.title === written) document.title = base;
    };
  }, [count]);
}

/** The workspace's unread messages in the tab's title, on every page of the workspace. Renders nothing. */
export const ChatUnreadTitle = observer(function ChatUnreadTitle() {
  const { totalUnread } = useChat();
  useUnreadTitle(totalUnread);
  return null;
});
