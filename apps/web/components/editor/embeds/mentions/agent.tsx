/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { AiStarFourFilled } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
// hooks
import { useChat } from "@/hooks/store/use-chat";

type Props = {
  /** The agent's registry ID. */
  id: string;
};

/**
 * An @mention of an agent in Nexus Messages. It looks unlike a person's mention: an agent's mark, and no profile to
 * open. Named from the agents the chat store holds; "Agent" until those are loaded, or for one it doesn't know.
 */
export const EditorAgentMention = observer(function EditorAgentMention({ id }: Props) {
  const { t } = useTranslation();
  const { getAgentName } = useChat();
  const name = getAgentName(id) ?? t("messages.agent.tag");
  return (
    <span
      data-agent-mention={id}
      className="not-prose inline-flex items-baseline gap-0.5 rounded-sm border border-subtle bg-layer-2 px-1 py-0.5 text-primary no-underline"
    >
      <AiStarFourFilled className="size-3 self-center text-accent-primary" aria-hidden />@{name}
    </span>
  );
});
