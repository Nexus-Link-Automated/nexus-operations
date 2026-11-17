# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Handing queued jobs to machines, hearing back from them, and ending jobs whose machine went quiet.

A machine asks for work in its heartbeat (`heartbeat_jobs`), listing the jobs it is running. In one transaction,
with the machine and its owner's workspace membership locked and read again (so a revoke or a demotion that landed
after the key was checked wins), the CRM:

1. matches the machine's list against the jobs it gave it: a job the machine no longer runs ends as a job error
   (unless the machine never confirmed it, in which case it is offered again for `ACK_WINDOW`), and a job the
   machine runs that the CRM has ended (cancelled, timed out) goes in `cancel`;
2. hands out queued jobs of the machine's owner: ones that asked for this machine, and Auto ones (no machine) for an
   agent this machine has installed and signed in, oldest first, up to its free slots. Each becomes `running` on it.

Two machines of the same owner asking at once never get the same Auto job: queued jobs are locked with
`SKIP LOCKED`. Progress (`record_events`) and the result (`apply_machine_result`) come from the machine's other
endpoints. `expire_jobs` (every minute, from Celery beat) ends running jobs whose machine went silent or whose
deadline passed.
"""

import logging
from dataclasses import dataclass, field
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone

from plane.coding.exceptions import CodingError, Conflict, InvalidResult, NotFound
from plane.coding.instructions import build_instructions
from plane.coding.machines import MachineAuthError, MachineOwnerNotAllowed, MEMBER_ROLE
from plane.coding.models import (
    EVENT_TEXT_MAX,
    MAX_EVENTS_PER_JOB,
    CodingJob,
    CodingJobEvent,
    CodingMachine,
    JobOutcome,
    JobStatus,
    MachineState,
    ProjectCodingSettings,
)
from plane.coding.outcomes import apply_result
from plane.db.models import Issue, ProjectMember, WorkspaceMember
from plane.utils.host import base_host

logger = logging.getLogger("plane.coding")

__all__ = [
    "ACK_WINDOW",
    "DEADLINE_GRACE",
    "SILENT_WINDOW",
    "Handout",
    "apply_machine_result",
    "end_queued_for",
    "expire_jobs",
    "heartbeat_jobs",
    "job_timeout",
    "record_events",
]

# How long a job runs before the machine stops it. `CODING_JOB_TIMEOUT_MINUTES` changes it.
DEFAULT_TIMEOUT = timedelta(minutes=60)
# A job handed out but not yet confirmed by the machine is offered again in its heartbeats for this long (the answer
# that carried it may have been lost); after that it ends as a job error.
ACK_WINDOW = timedelta(seconds=60)
# A running job whose machine has sent no heartbeat for this long ends as a job error. Longer than the online window,
# so a short network drop does not end a job.
SILENT_WINDOW = timedelta(minutes=3)
# The machine stops a job at its deadline and reports it; the CRM ends it itself this long after, if it has not.
DEADLINE_GRACE = timedelta(minutes=2)
PROGRESS_MAX = 500


def job_timeout() -> timedelta:
    minutes = getattr(settings, "CODING_JOB_TIMEOUT_MINUTES", None)
    try:
        return timedelta(minutes=int(minutes)) if minutes else DEFAULT_TIMEOUT
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT


@dataclass
class Handout:
    jobs: list = field(default_factory=list)
    cancel: list = field(default_factory=list)


def _end(job: CodingJob, reason: str) -> None:
    """End an active job as a job error; a job that ended meanwhile is left as it is."""
    try:
        apply_result(job, {"outcome": JobOutcome.JOB_ERROR.value, "reason": reason})
    except (Conflict, InvalidResult):
        pass


def _ready_agents(machine: CodingMachine) -> set:
    agents = (machine.capabilities or {}).get("agents") or []
    return {a.get("id") for a in agents if isinstance(a, dict) and a.get("installed") and a.get("signed_in")}


def _reported_free(machine: CodingMachine) -> int:
    slots = (machine.capabilities or {}).get("slots") or {}
    total, free = slots.get("total"), slots.get("free")
    if not isinstance(total, int) or not isinstance(free, int):
        return 0
    return max(0, min(free, total))


def _lock_machine(machine: CodingMachine) -> CodingMachine:
    """The machine and its owner, read again under lock. Raises as `authenticate_key` would."""
    locked = CodingMachine.objects.select_for_update(of=("self",)).select_related("workspace", "owner")
    machine = locked.filter(pk=machine.pk).first()
    if machine is None:
        raise MachineAuthError(
            "This machine key is not valid. The machine may have been removed.", code="MACHINE_UNKNOWN"
        )
    if machine.state == MachineState.REVOKED:
        raise MachineAuthError("This machine was revoked by a workspace admin.", code="MACHINE_REVOKED")
    # Locks the owner's membership row, so a demotion or removal either lands before this read or waits for the
    # handout to commit. A missing row (removed) reads as not allowed.
    member = (
        WorkspaceMember.objects.select_for_update(of=("self",))
        .filter(workspace_id=machine.workspace_id, member_id=machine.owner_id)
        .values("role", "is_active", "member__is_active")
        .first()
    )
    if not member or not member["is_active"] or not member["member__is_active"] or member["role"] < MEMBER_ROLE:
        raise MachineOwnerNotAllowed("The machine's owner can no longer run coding jobs in this workspace.")
    return machine


def _why_not_runnable(job: CodingJob) -> str | None:
    """Why a queued job can no longer run, or None. Checked when a machine is about to take it."""
    if not Issue.issue_objects.filter(pk=job.issue_id).exists():
        return "The work item was archived, deleted or moved back to intake before a machine took the job."
    coding_settings = ProjectCodingSettings.objects.filter(project_id=job.project_id).first()
    if coding_settings is None or not coding_settings.is_configured:
        return "Coding jobs were turned off for this project before a machine took the job."
    if not ProjectMember.objects.filter(
        project_id=job.project_id, member_id=job.requested_by_id, is_active=True, role__gte=MEMBER_ROLE
    ).exists():
        return "The person who started the job can no longer run coding jobs in this project."
    return None


def _order(job: CodingJob) -> dict:
    """What the machine gets for a job: the instructions the CRM wrote, and where the code is."""
    coding_settings = ProjectCodingSettings.objects.get(project_id=job.project_id)
    issue = job.issue
    timeout = max(60, int((job.deadline_at - job.started_at).total_seconds())) if job.deadline_at else None
    return {
        "id": str(job.id),
        "action": job.action,
        "agent": job.agent,
        "repo_url": coding_settings.repo_url,
        "branch": coding_settings.default_branch,
        "work_item": {
            "id": str(issue.id),
            "identifier": f"{issue.project.identifier}-{issue.sequence_id}",
            "name": issue.name[:255],
            "url": f"{base_host(request=None, is_app=True).rstrip('/')}/{job.workspace.slug}/browse/"
            f"{issue.project.identifier}-{issue.sequence_id}/",
        },
        "instructions": build_instructions(job, coding_settings.default_branch),
        "timeout_seconds": timeout or int(job_timeout().total_seconds()),
    }


def heartbeat_jobs(machine: CodingMachine, running) -> Handout:
    """Reconcile what the machine runs and hand it new jobs. `running` is the list of job ids the machine says it is
    running, or None when the machine did not say (it gets no new jobs then)."""
    handout = Handout()
    now = timezone.now()
    ended: list[tuple[CodingJob, str]] = []
    with transaction.atomic():
        machine = _lock_machine(machine)
        if running is None:
            return handout
        running = {str(job_id) for job_id in running}
        # `all_objects`: a job whose work item was deleted is soft-deleted with it, but still runs on the machine
        # until it is ended here or by its result.
        mine = list(
            CodingJob.all_objects.select_for_update(of=("self",))
            .select_related("issue", "issue__project", "workspace")
            .filter(ran_on=machine, status=JobStatus.RUNNING)
        )
        mine_ids = {str(job.id) for job in mine}
        handout.cancel = sorted(running - mine_ids)
        still_running = 0
        for job in mine:
            if str(job.id) in running:
                still_running += 1
                if job.acked_at is None:
                    job.acked_at = now
                    job.save(update_fields=["acked_at", "updated_at"])
            elif job.acked_at is None and now - job.started_at < ACK_WINDOW:
                # The answer that carried it may not have arrived: offer it again.
                still_running += 1
                handout.jobs.append(_order(job))
            elif job.acked_at is None:
                ended.append((job, f"The machine {machine.name} did not start the job."))
            else:
                ended.append(
                    (job, f"The machine {machine.name} stopped running the job unexpectedly (it may have restarted).")
                )

        free = 0
        if machine.state == MachineState.ACTIVE:
            total = ((machine.capabilities or {}).get("slots") or {}).get("total")
            total = total if isinstance(total, int) else 0
            free = max(0, min(_reported_free(machine), total - still_running))
        agents = _ready_agents(machine)
        if free and agents:
            queued = (
                CodingJob.objects.select_for_update(of=("self",), skip_locked=True)
                .select_related("issue", "issue__project", "workspace")
                .filter(
                    status=JobStatus.QUEUED,
                    workspace_id=machine.workspace_id,
                    requested_by_id=machine.owner_id,
                    agent__in=agents,
                )
                .filter(Q(machine=machine) | Q(machine__isnull=True))
                .order_by("created_at")[: free + 10]
            )
            for job in queued:
                if free <= 0:
                    break
                reason = _why_not_runnable(job)
                if reason:
                    ended.append((job, reason))
                    continue
                job.status = JobStatus.RUNNING
                job.started_at = now
                job.deadline_at = now + job_timeout()
                job.ran_on = machine
                job.ran_on_name = machine.name
                job.acked_at = None
                job.progress = "Handed to the machine."
                job.progress_at = now
                job.save(
                    update_fields=[
                        "status",
                        "started_at",
                        "deadline_at",
                        "ran_on",
                        "ran_on_name",
                        "acked_at",
                        "progress",
                        "progress_at",
                        "updated_at",
                    ]
                )
                handout.jobs.append(_order(job))
                free -= 1
    # Outside the handout's transaction, so one job's outcome cannot undo the handout.
    for job, reason in ended:
        _end(job, reason)
    return handout


def end_queued_for(machine: CodingMachine, reason: str) -> int:
    """End the queued jobs that asked for `machine` (revoked: it will never take them). Returns how many."""
    jobs = list(CodingJob.objects.filter(machine=machine, status=JobStatus.QUEUED))
    for job in jobs:
        _end(job, reason)
    return len(jobs)


def _machine_job(machine: CodingMachine, job_id) -> CodingJob:
    job = CodingJob.all_objects.filter(pk=job_id, ran_on=machine).first()
    if job is None:
        raise NotFound("No such job on this machine.", code="JOB_NOT_FOUND")
    return job


def record_events(machine: CodingMachine, batches: list[dict]) -> list[str]:
    """Store progress lines for jobs running on this machine. Returns the ids of jobs that are no longer running on
    it (ended, cancelled, or never its), so the machine stops them."""
    ended = []
    now = timezone.now()
    for batch in batches:
        job_id, events = str(batch["id"]), batch["events"]
        with transaction.atomic():
            job = (
                CodingJob.all_objects.select_for_update(of=("self",))
                .filter(pk=job_id, ran_on=machine, status=JobStatus.RUNNING)
                .first()
            )
            if job is None:
                ended.append(job_id)
                continue
            if not events:
                continue
            last = job.events.aggregate(seq=Max("seq"))["seq"] or 0
            CodingJobEvent.objects.bulk_create(
                [
                    CodingJobEvent(job=job, seq=last + index, kind=event["kind"], text=event["text"][:EVENT_TEXT_MAX])
                    for index, event in enumerate(events, start=1)
                ]
            )
            newest = last + len(events)
            if newest > MAX_EVENTS_PER_JOB:
                CodingJobEvent.objects.filter(job=job, seq__lte=newest - MAX_EVENTS_PER_JOB).delete(soft=False)
            job.progress = " ".join(events[-1]["text"].split())[:PROGRESS_MAX]
            job.progress_at = now
            if job.acked_at is None:
                job.acked_at = now
            job.save(update_fields=["progress", "progress_at", "acked_at", "updated_at"])
    return ended


def apply_machine_result(machine: CodingMachine, job_id, result):
    """Apply the machine's result for a job it ran. Applying the same result again changes nothing."""
    job = _machine_job(machine, job_id)
    return apply_result(job, result)


def expire_jobs(now=None) -> int:
    """End running jobs whose machine went silent or was removed, or whose deadline passed. Returns how many."""
    now = now or timezone.now()
    candidates = (
        CodingJob.all_objects.filter(status=JobStatus.RUNNING)
        .filter(
            Q(ran_on__isnull=True)
            | Q(ran_on__last_seen_at__lt=now - SILENT_WINDOW)
            | Q(ran_on__state=MachineState.REVOKED)
            | Q(deadline_at__lt=now - DEADLINE_GRACE)
        )
        .select_related("ran_on")
    )
    count = 0
    for job in candidates:
        name = job.ran_on_name or "running it"
        if job.deadline_at and job.deadline_at < now - DEADLINE_GRACE:
            minutes = int((job.deadline_at - job.started_at).total_seconds() // 60) if job.started_at else None
            reason = f"The job ran out of time ({minutes} minutes)." if minutes else "The job ran out of time."
        elif job.ran_on is None:
            reason = f"The machine {name} was removed during the job."
        elif job.ran_on.state == MachineState.REVOKED:
            reason = f"The machine {name} was revoked during the job."
        else:
            reason = f"The machine {name} stopped answering during the job."
        try:
            _end(job, reason)
            count += 1
        except CodingError:  # pragma: no cover - logged, the next run tries again
            logger.exception("coding: could not end job %s", job.id)
    return count
