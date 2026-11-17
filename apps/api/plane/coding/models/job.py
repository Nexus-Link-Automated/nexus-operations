# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A coding job: one action a coding agent does for one work item.

A job is started by a person (or an agent acting as a user) from the work item. It stays `queued` until one of the
requester's machines takes it in a heartbeat (`plane.coding.dispatch`); it is then `running` on that machine
(`ran_on`). It ends with exactly one `outcome`, which only `plane.coding.outcomes.apply_result` sets: that service
moves the work item and writes the comment, so the coding agent never changes the work item itself.

At most one job per work item and action is active (queued, running or waiting for input) at a time. The partial
unique constraint holds that even when two requests race; the API answers the loser with 409 `JOB_ACTIVE`.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q

from plane.db.models import BaseModel

__all__ = ["ACTIVE_STATUSES", "CodingAction", "CodingAgent", "CodingJob", "JobOutcome", "JobStatus"]


class CodingAction(models.TextChoices):
    FIX_BUG = "fix_bug", "Fix bug"
    WRITE_TEST = "write_test", "Write test"
    WRITE_AND_RUN_TEST = "write_and_run_test", "Write & run test"


class CodingAgent(models.TextChoices):
    CODEX = "codex", "Codex"
    CLAUDE = "claude", "Claude"


class JobStatus(models.TextChoices):
    QUEUED = "queued", "Queued"
    RUNNING = "running", "Running"
    NEEDS_INPUT = "needs_input", "Needs input"
    FINISHED = "finished", "Finished"
    CANCELLED = "cancelled", "Cancelled"


class JobOutcome(models.TextChoices):
    FIXED = "fixed", "Fixed"
    COULD_NOT_FIX = "could_not_fix", "Could not fix"
    TEST_WRITTEN = "test_written", "Test written"
    TEST_PASSED = "test_passed", "Test passed"
    BUG_FOUND = "bug_found", "Bug found"
    JOB_ERROR = "job_error", "Job error"


ACTIVE_STATUSES = (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.NEEDS_INPUT)


class CodingJob(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="coding_jobs")
    project = models.ForeignKey("db.Project", on_delete=models.CASCADE, related_name="coding_jobs")
    issue = models.ForeignKey("db.Issue", on_delete=models.CASCADE, related_name="coding_jobs")
    action = models.CharField(max_length=32, choices=CodingAction.choices)
    agent = models.CharField(max_length=32, choices=CodingAgent.choices)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="coding_jobs_requested"
    )
    status = models.CharField(max_length=32, choices=JobStatus.choices, default=JobStatus.QUEUED)
    outcome = models.CharField(max_length=32, choices=JobOutcome.choices, null=True, blank=True)
    # The validated result the outcome was applied from (`plane.coding.outcomes.validate_result`).
    result = models.JSONField(default=dict, blank=True)
    pr_url = models.URLField(max_length=2000, blank=True, default="")
    error_reason = models.TextField(blank=True, default="")
    retry_of = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="retries")
    # The requester's machine the job asked for; null means Auto (any of the requester's machines).
    machine = models.ForeignKey(
        "coding.CodingMachine", on_delete=models.SET_NULL, null=True, blank=True, related_name="jobs"
    )
    # The machine that took the job, and its name then (kept when the machine is removed).
    ran_on = models.ForeignKey(
        "coding.CodingMachine", on_delete=models.SET_NULL, null=True, blank=True, related_name="ran_jobs"
    )
    ran_on_name = models.CharField(max_length=80, blank=True, default="")
    # When the machine first said it is running the job; until then the job is offered to it again.
    acked_at = models.DateTimeField(null=True, blank=True)
    # The machine stops the job at this time; the CRM ends it soon after if the machine does not report.
    deadline_at = models.DateTimeField(null=True, blank=True)
    # The latest progress line the machine reported, and when.
    progress = models.CharField(max_length=500, blank=True, default="")
    progress_at = models.DateTimeField(null=True, blank=True)
    # The comment the outcome wrote on the work item.
    comment = models.ForeignKey(
        "db.IssueComment", on_delete=models.SET_NULL, null=True, blank=True, related_name="coding_jobs"
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "coding_jobs"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=["issue", "-created_at"], name="coding_job_issue_created"),
            models.Index(fields=["status", "requested_by"], name="coding_job_status_requester"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["issue", "action"],
                condition=Q(status__in=[s.value for s in ACTIVE_STATUSES], deleted_at__isnull=True),
                name="coding_job_one_active_per_action",
            ),
        ]

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_STATUSES

    @property
    def is_retryable(self) -> bool:
        return self.status == JobStatus.CANCELLED or self.outcome == JobOutcome.JOB_ERROR

    def save(self, *args, **kwargs):
        self.project_id = self.issue.project_id
        self.workspace_id = self.issue.workspace_id
        super().save(*args, **kwargs)
