/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@makeplane/propel/components/menu";
import { CodeOutline } from "@makeplane/propel/icons";
import { Icon } from "@makeplane/propel/components/icon";
import { useTranslation } from "@plane/i18n";
import type { TCodingAction } from "@plane/types";
// hooks
import { useCodingJob } from "@/hooks/store/use-coding-job";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProjectState } from "@/hooks/store/use-project-state";
// local imports
import { CODING_ACTIONS, isWorkItemEligibleForCoding } from "./helpers";
import { CodingJobStartDialog } from "./start-dialog";
import { useCodingAccess } from "./use-coding-access";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
};

/**
 * "Coding job" on a work item's header: Fix bug, Write test, Write & run test. Shown only to project members and
 * admins, only when the project has coding jobs set up, and never on drafts, archived items or intake items.
 */
export const CodingJobActions = observer(function CodingJobActions({ workspaceSlug, projectId, issueId }: Props) {
  const { t } = useTranslation();
  const [action, setAction] = useState<TCodingAction | null>(null);
  // store hooks
  const { getSettings, fetchSettings, startJob } = useCodingJob();
  const {
    issue: { getIssueById },
  } = useIssueDetail();
  const { getStateById } = useProjectState();
  const { canWrite } = useCodingAccess(workspaceSlug, projectId);
  // derived values
  const issue = getIssueById(issueId);
  const settings = getSettings(projectId);
  const eligible = isWorkItemEligibleForCoding(issue, issue?.state_id ? getStateById(issue.state_id) : undefined);
  const showButton = canWrite && eligible && !!settings?.configured;

  // A dialog belongs to one work item: close it when the peek moves to another.
  useEffect(() => setAction(null), [issueId]);

  useEffect(() => {
    // Guests cannot read coding settings (403), so only members and admins ask.
    if (!canWrite || !workspaceSlug || !projectId) return;
    fetchSettings(workspaceSlug, projectId).catch(() => undefined);
  }, [canWrite, workspaceSlug, projectId, fetchSettings]);

  // An open dialog stays open even if the button goes away (say a refusal showed coding was switched off), so its
  // message stays on screen.
  if (!showButton && !action) return null;

  return (
    <>
      {showButton && (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="md"
                stretch="auto"
                label={t("coding_jobs.menu.trigger")}
                aria-label={t("coding_jobs.menu.trigger")}
              />
            }
          />
          <MenuContent side="bottom" align="end">
            {CODING_ACTIONS.map((value) => (
              <MenuItem
                key={value}
                icon={<Icon icon={CodeOutline} />}
                label={t(`coding_jobs.actions.${value}`)}
                onClick={() => setAction(value)}
              />
            ))}
          </MenuContent>
        </Menu>
      )}
      {action && (
        <CodingJobStartDialog
          workspaceSlug={workspaceSlug}
          action={action}
          onStart={(agent, machine) => startJob(workspaceSlug, projectId, issueId, action, agent, machine)}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
});
