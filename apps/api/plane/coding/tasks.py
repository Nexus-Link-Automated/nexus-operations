# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Celery tasks for coding jobs."""

from celery import shared_task

from plane.coding.dispatch import expire_jobs
from plane.coding.publish import publish_job
from plane.coding.retention import purge
from plane.coding.questions import expire_questions, think


@shared_task
def expire_coding_jobs():
    """End running jobs whose machine went silent or was removed, or that ran past their deadline (every minute)."""
    return expire_jobs() + expire_questions()


@shared_task
def purge_coding_history():
    """Daily: progress lines of jobs that ended long ago, and old audit events (`plane.coding.retention`)."""
    return purge()


@shared_task
def publish_coding_job(job_id):
    """Push a finished job's changes to its own branch, open the pull request and apply the outcome."""
    publish_job(job_id)


@shared_task
def think_about_question(question_id):
    """The CRM agent answers a coding agent's question from the work item, or it goes to the people."""
    think(question_id)
