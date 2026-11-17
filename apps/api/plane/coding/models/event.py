# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A progress line a machine reported while running a job: what the agent said, which tool it ran, its plan.

The machine condenses the agent's stream into short lines. They are written by a coding agent that read work-item
text, so they are shown as plain text only. A job keeps its latest `MAX_EVENTS_PER_JOB`.
"""

from django.db import models

from plane.db.models import BaseModel

__all__ = ["CodingJobEvent", "EventKind", "MAX_EVENTS_PER_JOB", "EVENT_TEXT_MAX"]

MAX_EVENTS_PER_JOB = 500
EVENT_TEXT_MAX = 2000


class EventKind(models.TextChoices):
    STATUS = "status", "Status"
    MESSAGE = "message", "Message"
    TOOL = "tool", "Tool"
    PLAN = "plan", "Plan"


class CodingJobEvent(BaseModel):
    job = models.ForeignKey("coding.CodingJob", on_delete=models.CASCADE, related_name="events")
    # 1, 2, 3, ... per job, in the order the CRM received them.
    seq = models.PositiveIntegerField()
    kind = models.CharField(max_length=16, choices=EventKind.choices)
    text = models.TextField()

    class Meta:
        db_table = "coding_job_events"
        ordering = ("job", "seq")
        constraints = [models.UniqueConstraint(fields=["job", "seq"], name="coding_job_event_seq")]
