/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Avatar } from "@makeplane/propel/components/avatar";
import { AiStarFourFilled } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import type { TAgentAdapter } from "@plane/types";
import { cn, getFileURL } from "@plane/utils";
// components
import { AgentAdapterIcon } from "@/components/agents/adapter-icon";
// hooks
import { useMember } from "@/hooks/store/use-member";

type Props = {
  userId: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg";
};

export const MemberAvatar = observer(function MemberAvatar({ userId, size = "md" }: Props) {
  const { getUserDetails } = useMember();
  const user = userId ? getUserDetails(userId) : undefined;
  const name = user?.display_name ?? "";
  return (
    <Avatar
      alt={name}
      fallback={name[0]?.toUpperCase() ?? "?"}
      src={user?.avatar_url ? getFileURL(user.avatar_url) : undefined}
      size={size}
    />
  );
});

const AGENT_AVATAR_SIZES = { xs: "size-4", sm: "size-5", md: "size-8", lg: "size-10" } as const;

type AgentProps = {
  /** Null for an agent the registry no longer has. */
  adapter: TAgentAdapter | null;
  size?: keyof typeof AGENT_AVATAR_SIZES;
  /** Its name, where nothing beside the avatar says it. */
  name?: string;
};

/** An agent in place of a person's avatar: its provider's mark. */
export function ChatAgentAvatar({ adapter, size = "md", name }: AgentProps) {
  return (
    <span
      className={cn(
        "grid flex-shrink-0 place-items-center rounded-full bg-layer-2 text-secondary",
        AGENT_AVATAR_SIZES[size]
      )}
      {...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
    >
      {adapter ? (
        <AgentAdapterIcon adapter={adapter} className={size === "md" || size === "lg" ? "size-4" : "size-3"} />
      ) : (
        <AiStarFourFilled className={size === "md" || size === "lg" ? "size-4" : "size-3"} />
      )}
    </span>
  );
}

/** The tag beside an agent's name, wherever people and agents show together. */
export function ChatAgentTag() {
  const { t } = useTranslation();
  return (
    <span className="rounded-sm bg-layer-2 px-1 text-caption-sm-medium text-tertiary">{t("messages.agent.tag")}</span>
  );
}
