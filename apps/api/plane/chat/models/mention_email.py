# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""@mentions waiting to be emailed in a digest (`plane.chat.digest`).

A row is a queue entry, not a record: the digest run deletes it as it takes it, whether or not an email follows, so
no mention is emailed twice. That is also why this is not a `BaseModel`: a soft deleted row would still be queued.
"""

import uuid

from django.db import models
from django.utils import timezone

__all__ = ["PendingMentionEmail"]


class PendingMentionEmail(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # The inbox entry the mention made; its receiver is copied to `receiver` so a run can take one person's at a time.
    notification = models.OneToOneField("db.Notification", on_delete=models.CASCADE, related_name="+")
    receiver = models.ForeignKey("db.User", on_delete=models.CASCADE, related_name="+")
    message = models.ForeignKey("chat.Message", on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "chat_pending_mention_emails"
        ordering = ("created_at",)
        indexes = [models.Index(fields=["created_at"], name="chat_pending_mention_due_idx")]
