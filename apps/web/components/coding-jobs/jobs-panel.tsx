/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Badge } from "@makeplane/propel/components/badge";
import { Button } from "@makeplane/propel/components/button";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { GitPullRequestOutline, RefreshOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TCodingJob } from "@plane/types";
import { calculateTimeAgo, renderFormattedDate } from "@plane/utils";
// hooks
import { useCodingJob } from "@/hooks/store/use-coding-job";
import { useMember } from "@/hooks/store/use-member";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProjectState } from "@/hooks/store/use-project-state";
import { useUser } from "@/hooks/store/user";
// local imports
import { codingErrorMessage, isWorkItemEligibleForCoding } from "./helpers";
import { CodingJobProgress } from "./job-progress";
import { useCodingAccess } from "./use-coding-access";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
};

type TBadgeVariant = "neutral" | "info" | "warning" | "grey" | "success" | "danger";

const STATUS_VARIANT: Record<TCodingJob["status"], TBadgeVariant> = {
  queued: "neutral",
  running: "info",
  needs_input: "warning",
  finished: "neutral",
  cancelled: "grey",
};

const OUTCOME_VARIANT: Record<NonNullable<TCodingJob["outcome"]>, TBadgeVariant> = {
  fixed: "success",
  test_written: "success",
  test_passed: "success",
  could_not_fix: "warning",
  bug_found: "danger",
  job_error: "grey",
};

const DATE_FORMAT = "MMM d, yyyy h:mma";

/** Only links the API itself accepted (https) are made clickable. */
const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The work item's coding jobs, newest first: status or outcome, the machine it ran on, the latest progress line while
 * it runs and its progress lines on demand, PR link, error reason, who started it and when. While a job is queued or
 * running, the store reloads the jobs every few seconds for as long as the panel is shown.
 * Cancel shows for an active job to the person who started it and to project admins; Retry for a job the API marks
 * `is_retryable`, to members and admins. Guests see the list only.
 */
export const CodingJobsPanel = observer(function CodingJobsPanel({ workspaceSlug, projectId, issueId }: Props) {
  const { t } = useTranslation();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  // store hooks
  const { getJobs, getSettings, fetchSettings, fetchJobs, watchJobs, cancelJob, retryJob } = useCodingJob();
  const { getUserDetails } = useMember();
  const { data: currentUser } = useUser();
  const {
    issue: { getIssueById },
  } = useIssueDetail();
  const { getStateById } = useProjectState();
  const { canWrite, isAdmin } = useCodingAccess(workspaceSlug, projectId);
  // derived values
  const jobs = getJobs(issueId);
  const settings = getSettings(projectId);
  const issue = getIssueById(issueId);
  // A retry is a new start, so it is offered only where a start would be accepted.
  const canStart =
    canWrite &&
    !!settings?.configured &&
    isWorkItemEligibleForCoding(issue, issue?.state_id ? getStateById(issue.state_id) : undefined);

  useEffect(() => {
    // Guests cannot read coding settings (403). The header asks too; the store sends one request.
    if (canWrite && workspaceSlug && projectId) fetchSettings(workspaceSlug, projectId).catch(() => undefined);
  }, [canWrite, workspaceSlug, projectId, fetchSettings]);

  const load = useCallback(() => {
    setLoadFailed(false);
    fetchJobs(workspaceSlug, projectId, issueId).catch(() => setLoadFailed(true));
  }, [fetchJobs, workspaceSlug, projectId, issueId]);

  useEffect(() => {
    if (workspaceSlug && projectId && issueId) load();
  }, [load, workspaceSlug, projectId, issueId]);

  // Live updates while a job is active; stops on unmount.
  useEffect(() => {
    if (!workspaceSlug || !projectId || !issueId) return undefined;
    return watchJobs(workspaceSlug, projectId, issueId);
  }, [watchJobs, workspaceSlug, projectId, issueId]);

  // Nothing to show until there is a job, unless members could start one here.
  const hasJobs = !!jobs && jobs.length > 0;
  if (!hasJobs && !loadFailed && !(canWrite && settings?.configured)) return null;

  const run = async (job: TCodingJob, kind: "cancel" | "retry") => {
    setBusyJobId(job.id);
    try {
      if (kind === "cancel") await cancelJob(workspaceSlug, projectId, issueId, job.id);
      else await retryJob(workspaceSlug, projectId, issueId, job.id);
      setToast({
        type: "success",
        title: t(kind === "cancel" ? "coding_jobs.toasts.cancelled" : "coding_jobs.toasts.retried"),
      });
    } catch (error) {
      setToast({
        type: "error",
        title: t(kind === "cancel" ? "coding_jobs.toasts.cancel_failed" : "coding_jobs.toasts.retry_failed"),
        message: codingErrorMessage(t, error),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t("coding_jobs.panel.title")}>
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-body-sm-semibold text-primary">{t("coding_jobs.panel.title")}</h5>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<Icon icon={RefreshOutline} />}
          aria-label={t("coding_jobs.panel.refresh")}
          onClick={load}
        />
      </div>
      {loadFailed && (
        <p className="text-caption-md-regular text-danger-primary">{t("coding_jobs.panel.load_failed")}</p>
      )}
      {!loadFailed && !hasJobs && jobs && (
        <p className="text-caption-md-regular text-tertiary">{t("coding_jobs.panel.empty")}</p>
      )}
      {hasJobs && (
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => {
            const requester = job.requested_by ? getUserDetails(job.requested_by) : undefined;
            const canCancel =
              job.is_active && canWrite && (isAdmin || (!!currentUser && job.requested_by === currentUser.id));
            const canRetry = job.is_retryable && canStart;
            // A cancelled job ends as a job error; "Cancelled" says more.
            const showOutcome = !!job.outcome && job.status !== "cancelled";
            const badgeLabel = showOutcome
              ? t(`coding_jobs.outcome.${job.outcome}`)
              : t(`coding_jobs.status.${job.status}`);
            const badgeVariant = showOutcome && job.outcome ? OUTCOME_VARIANT[job.outcome] : STATUS_VARIANT[job.status];
            return (
              <li
                key={job.id}
                data-testid="coding-job"
                className="flex flex-col gap-1.5 rounded-md border border-subtle px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-body-xs-medium text-primary">
                    {t(`coding_jobs.actions.${job.action}`)} · {t(`coding_jobs.agents.${job.agent}`)}
                  </span>
                  <Badge size="sm" variant={badgeVariant} label={badgeLabel} />
                </div>
                <span className="text-caption-sm-regular text-tertiary">
                  {t("coding_jobs.panel.requested_by", {
                    name: requester?.display_name ?? t("coding_jobs.panel.unknown_user"),
                  })}
                  {" · "}
                  <time dateTime={job.created_at} title={renderFormattedDate(new Date(job.created_at), DATE_FORMAT)}>
                    {calculateTimeAgo(job.created_at)}
                  </time>
                </span>
                {job.status === "queued" && (
                  <span className="text-caption-sm-regular text-tertiary">
                    {t("coding_jobs.panel.waiting_for_machine")}
                  </span>
                )}
                {job.status !== "queued" && job.ran_on_name && (
                  <span className="truncate text-caption-sm-regular text-tertiary">
                    {t("coding_jobs.panel.ran_on", { name: job.ran_on_name })}
                    {job.status === "running" && job.started_at && (
                      <>
                        {" · "}
                        <time
                          dateTime={job.started_at}
                          title={renderFormattedDate(new Date(job.started_at), DATE_FORMAT)}
                        >
                          {t("coding_jobs.panel.started", { time: calculateTimeAgo(job.started_at) })}
                        </time>
                      </>
                    )}
                  </span>
                )}
                {job.status === "running" && job.progress && (
                  <p
                    data-testid="coding-job-progress-line"
                    className="truncate text-caption-sm-regular text-secondary"
                    title={job.progress}
                  >
                    {job.progress}
                  </p>
                )}
                {job.finished_at && (
                  <span className="text-caption-sm-regular text-tertiary">
                    {t("coding_jobs.panel.finished", {
                      time: renderFormattedDate(new Date(job.finished_at), DATE_FORMAT) ?? "",
                    })}
                  </span>
                )}
                {job.error_reason && (
                  <p className="text-caption-sm-regular break-words text-secondary">
                    <span className="text-tertiary">{t("coding_jobs.panel.error_reason")}: </span>
                    {job.error_reason}
                  </p>
                )}
                {job.pr_url && isHttpsUrl(job.pr_url) && (
                  <a
                    href={job.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-caption-sm-regular text-accent-primary hover:underline"
                  >
                    <GitPullRequestOutline className="size-3.5 shrink-0" />
                    {t("coding_jobs.panel.pr")}
                  </a>
                )}
                {job.status !== "queued" && (
                  <CodingJobProgress
                    workspaceSlug={workspaceSlug}
                    projectId={projectId}
                    issueId={issueId}
                    jobId={job.id}
                  />
                )}
                {(canCancel || canRetry) && (
                  <div className="flex items-center gap-2 pt-1">
                    {canCancel && (
                      <Button
                        variant="secondary"
                        size="sm"
                        stretch="auto"
                        label={t("coding_jobs.panel.cancel")}
                        loading={busyJobId === job.id}
                        disabled={busyJobId !== null}
                        onClick={() => void run(job, "cancel")}
                      />
                    )}
                    {canRetry && (
                      <Button
                        variant="secondary"
                        size="sm"
                        stretch="auto"
                        label={t("coding_jobs.panel.retry")}
                        loading={busyJobId === job.id}
                        disabled={busyJobId !== null}
                        onClick={() => void run(job, "retry")}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
