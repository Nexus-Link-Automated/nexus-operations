/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { WorkItemsOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TChatMessage, TIssue } from "@plane/types";
// components
import { CreateUpdateIssueModal } from "@/components/issues/issue-modal/modal";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
import { useProject } from "@/hooks/store/use-project";
// local imports
import {
  defaultWorkItemAssignee,
  defaultWorkItemProject,
  mentionedUserIds,
  readLastWorkItemProject,
  workItemTitleFromMessage,
  writeLastWorkItemProject,
} from "./helpers";

type Props = {
  message: TChatMessage;
  workspaceSlug: string;
};

/** "Create work item" on a message: Plane's form, already filled in, then linked to the message when it is saved. */
export const ChatCreateWorkItemAction = observer(function ChatCreateWorkItemAction({ message, workspaceSlug }: Props) {
  const { t } = useTranslation();
  const { channelMap, userId, linkWorkItem } = useChat();
  const { joinedProjectIds } = useProject();
  const { project: projectMembers } = useMember();
  const [draft, setDraft] = useState<Partial<TIssue> | null>(null);
  const [preparing, setPreparing] = useState(false);

  const open = async () => {
    setPreparing(true);
    const projectId = defaultWorkItemProject(
      channelMap[message.channel]?.project,
      readLastWorkItemProject(workspaceSlug),
      joinedProjectIds
    );
    let memberIds: string[] = [];
    if (projectId) {
      // Without the member list nobody can be pre-assigned; the form still opens and can be filled in by hand.
      await projectMembers.fetchProjectMembers(workspaceSlug, projectId).catch(() => undefined);
      memberIds = projectMembers.getProjectMemberIds(projectId, false) ?? [];
    }
    const assignee = defaultWorkItemAssignee(mentionedUserIds(message.body_html), memberIds, userId);
    setDraft({
      name: workItemTitleFromMessage(message.body_stripped),
      description_html: message.body_html,
      project_id: projectId,
      assignee_ids: assignee ? [assignee] : [],
    });
    setPreparing(false);
  };

  const link = async (workItem: TIssue) => {
    if (workItem.project_id) writeLastWorkItemProject(workspaceSlug, workItem.project_id);
    try {
      await linkWorkItem(message.channel, message.id, workItem.id);
    } catch {
      setToast({ type: "error", title: t("messages.errors.link_work_item_failed") });
    }
  };

  return (
    <>
      <IconButton
        variant="ghost"
        size="sm"
        icon={<WorkItemsOutline />}
        aria-label={t("create_work_item")}
        disabled={preparing}
        onClick={() => void open()}
      />
      {draft && (
        <CreateUpdateIssueModal
          isOpen
          data={draft}
          onClose={() => setDraft(null)}
          onSubmit={link}
          fetchIssueDetails={false}
          modalTitle={t("create_work_item")}
        />
      )}
    </>
  );
});
