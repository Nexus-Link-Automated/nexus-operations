# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Exports of a workspace's messages, started from God mode (`plane.chat.export`).

A row is the record of one export, kept after its archive is deleted, so instance admins can see who exported what
and when. Not a `BaseModel`: Plane's hard delete job purges soft deleted rows, and this record isn't meant to go.
"""

import uuid

from django.db import models
from django.utils import timezone

__all__ = ["MessageExport", "MessageExportStatus"]


class MessageExportStatus(models.TextChoices):
    QUEUED = "queued", "Queued"
    RUNNING = "running", "Running"
    READY = "ready", "Ready"
    FAILED = "failed", "Failed"
    # Ready once; its archive has since been deleted.
    EXPIRED = "expired", "Expired"


class MessageExport(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # SET_NULL, and the slug and name kept, so the record outlives the workspace.
    workspace = models.ForeignKey("db.Workspace", on_delete=models.SET_NULL, null=True, related_name="+")
    workspace_slug = models.CharField(max_length=100)
    workspace_name = models.CharField(max_length=80)
    requested_by = models.ForeignKey("db.User", on_delete=models.SET_NULL, null=True, related_name="+")
    requested_by_email = models.CharField(max_length=255)
    # Public channels only, unless this is set: then private channels, DMs and group DMs too.
    include_private = models.BooleanField(default=False)
    status = models.CharField(max_length=16, choices=MessageExportStatus.choices, default=MessageExportStatus.QUEUED)
    # The archive's key in the instance's storage, while it is there.
    storage_key = models.CharField(max_length=255, blank=True, default="")
    size = models.BigIntegerField(default=0)
    channel_count = models.IntegerField(default=0)
    message_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)
    completed_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_message_exports"
        ordering = ("-created_at",)
        indexes = [models.Index(fields=["status", "expires_at"], name="chat_export_expiry_idx")]
