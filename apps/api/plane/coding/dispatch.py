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
    CodingJobChanges,
    CodingJobEvent,
    CodingMachine,
    JobOutcome,
    JobStatus,
    MachineState,
    ProjectCodingSettings,
)
from plane.coding import github
from plane.coding.audit import record
from plane.coding.outcomes import CODE_OUTCOMES, CRM_FIELDS, Applied, apply_result, reported_part, validate_result
from plane.coding.publish import no_pr_reason
from plane.db.models import Issue, ProjectMember, WorkspaceMember
from plane.utils.host import base_host

logger = logging.getLogger("plane.coding")

__all__ = [
    "ACK_WINDOW",
    "DEADLINE_GRACE",
    "PUBLISH_WINDOW",
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
# A job whose result arrived with changes is ended as a job error when its pull request is not open after this long.
PUBLISH_WINDOW = timedelta(minutes=15)
PROGRESS_MAX = 500
# A job on a machine: running, or waiting there for the answer to its agent's question.
ON_MACHINE = (JobStatus.RUNNING, JobStatus.NEEDS_INPUT)


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
            .filter(ran_on=machine, status__in=ON_MACHINE)
        )
        # A job whose result arrived is the CRM's now (it is opening the pull request): the machine is done with it,
        # whether or not it still lists it.
        publishing = {str(job.id) for job in mine if job.result_received_at is not None}
        mine = [job for job in mine if job.result_received_at is None]
        mine_ids = {str(job.id) for job in mine}
        handout.cancel = sorted(running - mine_ids - publishing)
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
                record(
                    job.workspace_id,
                    "job.handed_out",
                    "job",
                    job.id,
                    actor_name=f"machine {machine.name}",
                    project_id=job.project_id,
                    machine=str(machine.id),
                )
                free -= 1
    # Outside the handout's transaction, so one job's outcome cannot undo the handout.
    for job, reason in ended:
        _end(job, reason)
    _add_clone_access(handout.jobs)
    return handout


def _add_clone_access(orders: list) -> None:
    """A read-only token for each order whose repository is a private GitHub repository the App is installed on.
    Asked for outside the handout's transaction: GitHub is not called while rows are locked."""
    tokens = {}
    for order in orders:
        url = order["repo_url"]
        if url not in tokens:
            tokens[url] = github.clone_token(url)
        if tokens[url] is not None:
            order["clone_token"] = tokens[url].token


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
                .filter(pk=job_id, ran_on=machine, status__in=ON_MACHINE)
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


def apply_machine_result(
    machine: CodingMachine, job_id, result, changes: dict | None = None, *, changes_note: str = ""
) -> Applied:
    """Take the machine's result for a job it ran. Sending the same result again changes nothing.

    An outcome with code and `changes` is applied once the CRM has pushed the changes and opened the pull request
    (`plane.coding.publish`, in a task); until then the job stays running. Without changes, or when the project
    cannot have pull requests, the outcome is applied now, and its comment says why there is no pull request.
    """
    job = _machine_job(machine, job_id)
    if isinstance(result, dict):
        crm_only = [key for key in CRM_FIELDS if key in result]
        if crm_only:
            raise InvalidResult({key: ["Set by the CRM, never reported by a machine."] for key in crm_only})
    data = validate_result(job.action, result)
    if JobOutcome(data["outcome"]) not in CODE_OUTCOMES:
        return apply_result(job, data)
    if not changes:
        if changes_note:
            reason = changes_note
        elif data.get("changed_files"):
            reason = "the machine did not send the changed files to the CRM"
        else:
            reason = "the job changed no files"
        return apply_result(job, data, no_pr_reason=reason)
    reason = no_pr_reason(job.project_id)
    if reason:
        return apply_result(job, data, no_pr_reason=reason)

    from plane.coding.tasks import publish_coding_job

    with transaction.atomic():
        job = CodingJob.all_objects.select_for_update(of=("self",)).get(pk=job.pk)
        if job.outcome is not None:
            if reported_part(job.result) == data:
                return Applied(job, changed=False)
            raise Conflict("This job already has a different result.", code="RESULT_ALREADY_APPLIED")
        if not job.is_active:
            raise Conflict("This job has ended.", code="JOB_NOT_ACTIVE")
        if job.result_received_at is not None:
            pending = CodingJobChanges.objects.filter(job=job).values_list("result", flat=True).first()
            if pending == data:
                return Applied(job, changed=False)
            raise Conflict("This job already has a different result.", code="RESULT_ALREADY_APPLIED")
        CodingJobChanges.objects.create(
            job=job, base_commit=changes["base_commit"], files=changes["files"], result=data
        )
        now = timezone.now()
        job.result_received_at = now
        job.progress = "Opening a pull request."
        job.progress_at = now
        job.save(update_fields=["result_received_at", "progress", "progress_at", "updated_at"])
        job_id = str(job.id)
        transaction.on_commit(lambda: publish_coding_job.delay(job_id))
    return Applied(job, changed=True)


DEFAULT_QUEUE_TTL = timedelta(hours=24)


def queue_ttl() -> timedelta:
    hours = getattr(settings, "CODING_JOB_QUEUE_TTL_HOURS", None)
    try:
        return timedelta(hours=float(hours)) if hours else DEFAULT_QUEUE_TTL
    except (TypeError, ValueError):
        return DEFAULT_QUEUE_TTL


def expire_jobs(now=None) -> int:
    """End running jobs whose machine went silent or was removed, or whose deadline passed, and queued jobs no machine
    took in time (`CODING_JOB_QUEUE_TTL_HOURS`, 24). Returns how many."""
    now = now or timezone.now()
    count = 0
    ttl = queue_ttl()
    for job in CodingJob.objects.filter(status=JobStatus.QUEUED, created_at__lt=now - ttl):
        hours = round(ttl.total_seconds() / 3600)
        _end(
            job,
            f"No machine took the job within {hours} hours. Check that a machine of the person who started it is "
            "online and signed in to the agent, then retry.",
        )
        count += 1
    candidates = (
        CodingJob.all_objects.filter(status__in=ON_MACHINE)
        .filter(
            (
                Q(result_received_at__isnull=True)
                & (
                    Q(ran_on__isnull=True)
                    | Q(ran_on__last_seen_at__lt=now - SILENT_WINDOW)
                    | Q(ran_on__state=MachineState.REVOKED)
                    # The deadline does not run while the job waits for an answer (`plane.coding.questions`).
                    | (Q(status=JobStatus.RUNNING) & Q(deadline_at__lt=now - DEADLINE_GRACE))
                )
            )
            # The machine is done with a job whose result arrived; only the pull request can be late.
            | Q(result_received_at__lt=now - PUBLISH_WINDOW)
        )
        .select_related("ran_on")
    )
    for job in candidates:
        name = job.ran_on_name or "running it"
        if job.result_received_at is not None:
            where = f" on {job.ran_on_name}" if job.ran_on_name else " on the machine"
            reason = f"Could not open the pull request: it took too long. The changes stay in the job's folder{where}."
        elif job.status == JobStatus.RUNNING and job.deadline_at and job.deadline_at < now - DEADLINE_GRACE:
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
    # Changes of jobs that ended while they waited for their pull request (cancelled, timed out) are not kept.
    CodingJobChanges.objects.filter(job__outcome__isnull=False).delete(soft=False)
    return count
