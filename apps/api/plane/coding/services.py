# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Starting, cancelling and retrying coding jobs. The views check who may; these enforce the job's own rules."""

from django.db import IntegrityError, transaction

from plane.coding.exceptions import CodingError, Conflict, NotConfigured
from plane.coding.machines import available_machine
from plane.coding.models import (
    ACTIVE_STATUSES,
    CodingJob,
    CodingMachine,
    JobOutcome,
    JobStatus,
    MachineState,
    ProjectCodingSettings,
)
from plane.coding.outcomes import apply_result, user_name
from plane.db.models import Issue, IssueSubscriber


def require_configured(project) -> ProjectCodingSettings:
    coding_settings = ProjectCodingSettings.objects.filter(project=project).first()
    if coding_settings is None or not coding_settings.is_configured:
        raise NotConfigured(
            "Coding jobs are not set up for this project: a project admin must enable them and set the repository."
        )
    return coding_settings


def _active_conflict(issue, action) -> Conflict | None:
    active = CodingJob.objects.filter(issue=issue, action=action, status__in=ACTIVE_STATUSES).first()
    if active is None:
        return None
    return Conflict(
        "This work item already has an active job for this action.",
        code="JOB_ACTIVE",
        extra={"job_id": str(active.id)},
    )


def start_job(issue, action: str, agent: str, user, retry_of: CodingJob | None = None, machine_id=None) -> CodingJob:
    """`machine_id` is one of the requester's approved machines, or None for Auto."""
    require_configured(issue.project)
    # Not on drafts, archived work items or ones still waiting in intake: an outcome would move them.
    if not Issue.issue_objects.filter(pk=issue.pk).exists():
        raise CodingError(
            "Coding jobs can only run on active work items, not drafts, archived ones or ones waiting in intake.",
            code="WORK_ITEM_NOT_ELIGIBLE",
        )
    machine = available_machine(machine_id, issue.workspace, user) if machine_id else None
    conflict = _active_conflict(issue, action)
    if conflict:
        raise conflict
    try:
        with transaction.atomic():
            job = CodingJob.objects.create(
                issue=issue, action=action, agent=agent, requested_by=user, retry_of=retry_of, machine=machine
            )
            # So the outcome comment reaches the person who asked for the job.
            IssueSubscriber.objects.get_or_create(
                issue=issue,
                subscriber=user,
                defaults={"project_id": issue.project_id, "workspace_id": issue.workspace_id},
            )
            return job
    except IntegrityError:
        # Another request started one between the check and the insert (coding_job_one_active_per_action).
        raise _active_conflict(issue, action) or Conflict("Could not start the job.", code="JOB_ACTIVE")


def _not_active() -> Conflict:
    return Conflict("Only a queued, running or waiting job can be cancelled.", code="JOB_NOT_ACTIVE")


def cancel_job(job: CodingJob, user) -> CodingJob:
    """End an active job as cancelled. Per the outcomes table this is a job error: the work item stays where it is
    and gets the "Job did not finish" comment with a retry hint."""
    if not job.is_active:
        raise _not_active()
    reason = f"Cancelled by {user_name(user)}."
    try:
        applied = apply_result(
            job, {"outcome": JobOutcome.JOB_ERROR.value, "reason": reason}, status=JobStatus.CANCELLED
        )
    except Conflict:
        applied = None
    # Unchanged or refused: it ended between the check above and the lock (another cancel, or a result).
    if applied is None or not applied.changed:
        raise _not_active()
    return applied.job


_SAME_MACHINE = object()


def retry_job(job: CodingJob, user, agent: str | None = None, machine_id=_SAME_MACHINE) -> CodingJob:
    """Leave `machine_id` out to keep the job's machine when it is still one the retrier may use (else Auto)."""
    if not job.is_retryable:
        raise Conflict(
            "Only a job that was cancelled or ended in a job error can be retried.", code="JOB_NOT_RETRYABLE"
        )
    if machine_id is _SAME_MACHINE:
        machine_id = None
        if job.machine_id is not None:
            machine_id = (
                CodingMachine.objects.filter(
                    pk=job.machine_id, workspace_id=job.workspace_id, owner=user, state=MachineState.ACTIVE
                )
                .values_list("pk", flat=True)
                .first()
            )
    return start_job(job.issue, job.action, agent or job.agent, user, retry_of=job, machine_id=machine_id)
