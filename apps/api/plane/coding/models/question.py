# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A question a coding agent asked during its job, and its answer.

The machine sends the question over A2A (`plane.coding.a2a`). The CRM agent answers it from the work item when it
can; otherwise the person who started the job (or another project member) answers it, in the coding jobs panel,
through the API or MCP, or by replying in the job's Messages thread (`plane.coding.questions`). An unanswered
question ends after `CODING_QUESTION_TIMEOUT_MINUTES`, and the agent is told to go on without it.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q

from plane.db.models import BaseModel

__all__ = ["CodingJobQuestion", "MAX_QUESTIONS_PER_JOB", "QUESTION_TEXT_MAX", "QuestionStatus"]

MAX_QUESTIONS_PER_JOB = 3
QUESTION_TEXT_MAX = 4000


class QuestionStatus(models.TextChoices):
    # The CRM agent is reading the work item for an answer.
    THINKING = "thinking", "The CRM agent is looking for the answer"
    # Waiting for a person.
    WAITING = "waiting", "Waiting for a person"
    ANSWERED = "answered", "Answered"
    # Nobody answered in time, or the job ended first.
    UNANSWERED = "unanswered", "Not answered"


class CodingJobQuestion(BaseModel):
    job = models.ForeignKey("coding.CodingJob", on_delete=models.CASCADE, related_name="questions")
    # 1, 2, 3 per job.
    seq = models.PositiveSmallIntegerField()
    # The A2A message id the machine sent it with, so a resent question is not asked twice.
    message_id = models.CharField(max_length=100)
    question = models.TextField()
    status = models.CharField(max_length=16, choices=QuestionStatus.choices, default=QuestionStatus.THINKING)
    answer = models.TextField(blank=True, default="")
    # A person who answered; null with `answered_by_agent` when the CRM agent did.
    answered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    answered_by_agent = models.BooleanField(default=False)
    answered_at = models.DateTimeField(null=True, blank=True)
    # The top-level message of the question's thread in each channel linked to the project.
    chat_messages = models.ManyToManyField("chat.Message", blank=True, related_name="coding_questions")

    class Meta:
        db_table = "coding_job_questions"
        ordering = ("job", "seq")
        constraints = [
            models.UniqueConstraint(fields=["job", "seq"], name="coding_question_seq"),
            models.UniqueConstraint(fields=["job", "message_id"], name="coding_question_message"),
            # At most one open question per job at a time.
            models.UniqueConstraint(
                fields=["job"],
                condition=Q(status__in=["thinking", "waiting"]),
                name="coding_question_one_open",
            ),
        ]

    @property
    def is_open(self) -> bool:
        return self.status in (QuestionStatus.THINKING, QuestionStatus.WAITING)
