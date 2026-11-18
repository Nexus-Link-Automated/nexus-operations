/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useId, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { ChevronRightOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { cn, renderFormattedDate } from "@plane/utils";
// hooks
import { useCodingJob } from "@/hooks/store/use-coding-job";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  jobId: string;
};

/**
 * A job's progress lines behind a "Progress" toggle. Opening it loads them; while the job is active the store keeps
 * loading new ones. The lines are written by a coding agent, so they are rendered as plain text only.
 */
export const CodingJobProgress = observer(function CodingJobProgress({
  workspaceSlug,
  projectId,
  issueId,
  jobId,
}: Props) {
  const { t } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const { getEvents, fetchEvents, watchEvents } = useCodingJob();
  const events = getEvents(jobId);

  useEffect(() => {
    if (!open) return undefined;
    setLoadFailed(false);
    fetchEvents(workspaceSlug, projectId, issueId, jobId).catch(() => setLoadFailed(true));
    return watchEvents(workspaceSlug, projectId, issueId, jobId);
  }, [open, workspaceSlug, projectId, issueId, jobId, fetchEvents, watchEvents]);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit items-center gap-1 text-caption-sm-medium text-secondary hover:text-primary"
      >
        <ChevronRightOutline className={cn("size-3.5 shrink-0", { "rotate-90": open })} />
        {t("coding_jobs.panel.progress")}
      </button>
      {open && (
        <div id={listId}>
          {events && events.length > 0 ? (
            <ol className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-sm bg-layer-1 px-2 py-1.5">
              {events.map((event) => (
                <li key={event.seq} data-testid="coding-job-event" className="flex gap-2 text-caption-sm-regular">
                  <span
                    className="w-14 shrink-0 text-tertiary"
                    title={renderFormattedDate(new Date(event.created_at), "MMM d, yyyy h:mm:ssa")}
                  >
                    {t(`coding_jobs.event_kind.${event.kind}`)}
                  </span>
                  <span className="min-w-0 break-words whitespace-pre-wrap text-secondary">{event.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p
              className={cn("text-caption-sm-regular", loadFailed ? "text-danger-primary" : "text-tertiary")}
              aria-live="polite"
            >
              {t(
                loadFailed
                  ? "coding_jobs.panel.progress_load_failed"
                  : events
                    ? "coding_jobs.panel.progress_empty"
                    : "coding_jobs.panel.progress_loading"
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
});
