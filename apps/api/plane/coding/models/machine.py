# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A machine: one person's own computer that runs their coding jobs.

A machine belongs to one person in one workspace, and only that person's jobs go to it. Its life:

1. `pending`: the owner added it and got a one-time join code (shown once, stored hashed, short-lived).
2. `awaiting_approval`: the machine traded the code for its own key (stored hashed). It can connect and report, so
   the owner sees which computer joined, but it gets no jobs until the owner approves it.
3. `active`: approved. It is online while its heartbeats keep arriving.
4. `revoked`: a workspace admin cut it off. Its key no longer works; the record stays until the owner removes it.

Removing a machine deletes the record, and with it the key hash. The machine connects only out to the CRM; nothing
ever connects to it.
"""

from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from plane.db.models import BaseModel

__all__ = ["CodingMachine", "MachineState", "HEARTBEAT_SECONDS", "ONLINE_WINDOW"]

# How often the machine service sends its heartbeat, and how long after the last one it still counts as online.
HEARTBEAT_SECONDS = 15
ONLINE_WINDOW = timedelta(seconds=HEARTBEAT_SECONDS * 3)


class MachineState(models.TextChoices):
    PENDING = "pending", "Waiting for the machine to join"
    AWAITING_APPROVAL = "awaiting_approval", "Waiting for approval"
    ACTIVE = "active", "Active"
    REVOKED = "revoked", "Revoked"


class CodingMachine(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="coding_machines")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="coding_machines")
    name = models.CharField(max_length=80)
    state = models.CharField(max_length=32, choices=MachineState.choices, default=MachineState.PENDING)

    # SHA-256 of the one-time join code; cleared when the machine joins. Codes are random, so no salt is needed.
    join_code_hash = models.CharField(max_length=64, null=True, blank=True, unique=True)
    join_code_expires_at = models.DateTimeField(null=True, blank=True)
    # SHA-256 of the machine's own key; the key itself is only ever sent to the machine, once.
    key_hash = models.CharField(max_length=64, null=True, blank=True, unique=True)

    # What the machine says about itself. Shown to the owner before approval; never trusted for access.
    hostname = models.CharField(max_length=255, blank=True, default="")
    os = models.CharField(max_length=64, blank=True, default="")
    version = models.CharField(max_length=32, blank=True, default="")
    # The last report: agents installed and signed in, toolchains, Docker, job slots (`serializers.machine`).
    capabilities = models.JSONField(default=dict, blank=True)

    joined_at = models.DateTimeField(null=True, blank=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "coding_machines"
        ordering = ("created_at",)
        indexes = [models.Index(fields=["workspace", "owner"], name="coding_machine_ws_owner")]

    @property
    def is_online(self) -> bool:
        if self.state not in (MachineState.AWAITING_APPROVAL, MachineState.ACTIVE) or self.last_seen_at is None:
            return False
        return timezone.now() - self.last_seen_at <= ONLINE_WINDOW

    @property
    def join_code_expired(self) -> bool:
        return (
            self.state == MachineState.PENDING
            and self.join_code_expires_at is not None
            and self.join_code_expires_at <= timezone.now()
        )
