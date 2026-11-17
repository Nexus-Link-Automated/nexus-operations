# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""How long coding records are kept (`purge_coding_history`, daily).

- A job's progress lines (`CodingJobEvent`): 30 days after the job ended (`CODING_JOB_EVENT_RETENTION_DAYS`).
- Audit events (`CodingAuditEvent`): 365 days (`CODING_AUDIT_RETENTION_DAYS`).

Jobs themselves, their results, questions and answers stay with the work item, like its comments.
"""

from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from plane.coding.models import ACTIVE_STATUSES, CodingAuditEvent, CodingJobEvent

__all__ = ["purge"]


def _days(name: str, default: int) -> timedelta:
    try:
        return timedelta(days=max(1, int(getattr(settings, name, default))))
    except (TypeError, ValueError):
        return timedelta(days=default)


def purge(now=None) -> dict:
    now = now or timezone.now()
    events, _ = (
        CodingJobEvent.all_objects.filter(job__finished_at__lt=now - _days("CODING_JOB_EVENT_RETENTION_DAYS", 30))
        .exclude(job__status__in=ACTIVE_STATUSES)
        .delete()
    )
    audit, _ = CodingAuditEvent.all_objects.filter(
        created_at__lt=now - _days("CODING_AUDIT_RETENTION_DAYS", 365)
    ).delete()
    return {"events": events, "audit": audit}
