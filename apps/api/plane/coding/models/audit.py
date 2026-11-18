# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The coding audit trail: who started, cancelled, answered or changed what, which machine ran what, and which pull
request a job opened. Workspace admins read it (`GET coding-audit/`); it is kept `CODING_AUDIT_RETENTION_DAYS` (365).
"""

from django.conf import settings
from django.db import models

from plane.db.models import BaseModel

__all__ = ["CodingAuditEvent"]


class CodingAuditEvent(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="coding_audit_events")
    # Who did it: a person or a bot member; null when a machine or the CRM itself did (`actor_name` says which).
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    actor_name = models.CharField(max_length=255, blank=True, default="")
    # What happened, as `<thing>.<verb>`: job.started, machine.approved, bot.created, ...
    action = models.CharField(max_length=64)
    target_type = models.CharField(max_length=32)
    target_id = models.UUIDField(null=True, blank=True)
    project_id = models.UUIDField(null=True, blank=True)
    details = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "coding_audit_events"
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["workspace", "-created_at"], name="coding_audit_workspace_time")]
