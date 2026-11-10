/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { AiStarFourFilled, ShieldOutline } from "@makeplane/propel/icons";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// components
import { Button } from "@/components/ui/shadcn/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/shadcn/tooltip";
// hooks
import { useAgentChat } from "@/hooks/store/use-agent-chat";
import { useUserPermissions } from "@/hooks/store/user";
// local imports
import { pickInitialAgent, recallAgent } from "../helpers";
import { KHAIA_NAME } from "./constants";

const KhaiaPanel = lazy(() => import("./panel").then((module) => ({ default: module.KhaiaPanel })));

/** True on the full agent chat page, which shows the same chat, so the widget stays out of the way. */
export function isAgentsPage(pathname: string, workspaceSlug: string): boolean {
  return new RegExp(`^/${workspaceSlug}/agents(/|$)`).test(pathname);
}

type Props = { workspaceSlug: string };

/**
 * Khaia, the floating assistant: a bubble in the bottom-right corner of every workspace page
 * that opens a chat window in that corner. It shares the agent chat store with the full page at /:slug/agents,
 * so both show the same conversation. The socket opens the first time the window does, and stays
 * open while minimized so a running turn can finish (the bridge closes idle chats).
 */
export const KhaiaWidget = observer(function KhaiaWidget({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const store = useAgentChat();
  const { allowPermissions } = useUserPermissions();
  const { fetchAgents, openChat, closeChat } = store;
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  // Set when the window is minimized, so focus goes back to the bubble once it is rendered again.
  const restoreFocusRef = useRef(false);
  // Guests cannot run agents, so the list is not requested for them and the widget stays away.
  const canUseAgents = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE,
    workspaceSlug
  );
  useSWR(canUseAgents ? `WORKSPACE_AGENTS_${workspaceSlug}` : null, () => fetchAgents(workspaceSlug));

  const agents = store.getWorkspaceAgents(workspaceSlug);
  const onAgentsPage = isAgentsPage(pathname, workspaceSlug);
  const hidden = !canUseAgents || onAgentsPage || !agents?.length;
  const hasChat = store.workspaceSlug === workspaceSlug && !!store.agentId;
  const items = store.workspaceSlug === workspaceSlug ? (store.snapshot?.transcript.items.length ?? 0) : 0;
  const waitingOnPermission = !!store.snapshot?.permissions.length;

  // Replies that arrive while minimized light a dot on the bubble, as does a pending permission prompt.
  const [seenItems, setSeenItems] = useState(items);
  useEffect(() => {
    if (onAgentsPage || (open && !hidden)) setSeenItems(items);
  }, [onAgentsPage, open, hidden, items]);
  const unread = !open && hasChat && (items > seenItems || waitingOnPermission);

  // Open a chat the first time the window opens, unless the full page already did.
  useEffect(() => {
    if (!open || hidden || hasChat || !agents?.length) return;
    const initial = pickInitialAgent(agents, recallAgent(workspaceSlug));
    if (initial) void openChat(workspaceSlug, initial);
  }, [open, hidden, hasChat, agents, workspaceSlug, openChat]);

  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    launcherRef.current?.focus();
  }, [open]);

  // Only this widget ends the chat, as it outlives the full page: leaving the workspace closes
  // the socket, since the bridge caps open chats per member. Signing out closes it in the root store.
  useEffect(
    () => () => {
      if (store.workspaceSlug === workspaceSlug) closeChat();
    },
    [store, workspaceSlug, closeChat]
  );

  if (hidden) return null;

  const minimize = () => {
    setOpen(false);
    restoreFocusRef.current = true;
  };
  // A turn waiting on an approval goes nowhere until it is answered, so it gets more than the dot.
  const needsApproval = !open && hasChat && waitingOnPermission;
  let launcherLabel = t("agents.khaia.open", { name: KHAIA_NAME });
  if (needsApproval) launcherLabel = t("agents.khaia.approval_needed", { name: KHAIA_NAME });
  else if (unread) launcherLabel = t("agents.khaia.unread", { name: KHAIA_NAME });

  const bubble = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={launcherRef}
            size="icon-lg"
            aria-label={launcherLabel}
            onClick={() => setOpen(true)}
            className="relative rounded-full shadow-raised-300"
          />
        }
      >
        <AiStarFourFilled />
        {unread && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-3 rounded-full border-2 border-(--background-color-surface-1) bg-danger-primary"
          />
        )}
      </TooltipTrigger>
      <TooltipContent side="left">{launcherLabel}</TooltipContent>
    </Tooltip>
  );
  const launcher = (
    <div className="flex items-center gap-2">
      {needsApproval && (
        <Button variant="outline" onClick={() => setOpen(true)} className="rounded-full shadow-raised-200">
          <ShieldOutline className="text-accent-primary" />
          {t("agents.khaia.needs_approval", { name: KHAIA_NAME })}
        </Button>
      )}
      {bubble}
    </div>
  );

  // Open, the window takes the bottom-right corner in place of the bubble; minimized, the bubble is back.
  // The bubble also stays while the window's code loads the first time.
  return (
    <TooltipProvider>
      <div className="fixed right-4 bottom-4 z-30 max-sm:right-2 max-sm:bottom-2 max-sm:left-2 max-sm:flex max-sm:justify-end">
        {open ? (
          <Suspense fallback={launcher}>
            <KhaiaPanel
              workspaceSlug={workspaceSlug}
              onMinimize={minimize}
              className="h-[min(640px,calc(100dvh-2rem))] w-full sm:w-[400px]"
            />
          </Suspense>
        ) : (
          launcher
        )}
      </div>
    </TooltipProvider>
  );
});
