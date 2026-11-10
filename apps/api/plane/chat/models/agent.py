# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agents from the instance's agent registry (`AgentDefinition`) as members of public and private channels.

A table of its own rather than a nullable `user` on `ChannelMember`: a member row carries a person's role, read
cursor and notification level, and everything that counts, notifies, hands over or ends memberships reads it as a
person. An agent has none of those, so keeping it out of that table leaves every one of those paths as it was.

Who added the agent and when are `created_by` and `created_at`. Removing it soft deletes the row, like a member's.
The row is deleted for good with its agent when the agent leaves the registry. While the registry has the agent
disabled the row stays, but the agent is unavailable: listed as such, and nothing reaches it.

DMs and group DMs never have agents. An agent DM (`plane.chat.agent_dm`) has exactly one, from its creation. `save()`
refuses anything else, and so does the database (the trigger from migration 0009, replaced in 0011).
"""

from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q

from plane.db.models import BaseModel
from plane.license.models import AgentPermissionLevel

__all__ = ["AgentDmSession", "AgentPermissionRequest", "AgentPermissionStatus", "ChannelAgent"]

_ALIVE = Q(deleted_at__isnull=True)


class ChannelAgent(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="chat_channel_agents")
    channel = models.ForeignKey("chat.Channel", on_delete=models.CASCADE, related_name="agents")
    agent = models.ForeignKey(
        "license.AgentDefinition", on_delete=models.CASCADE, related_name="chat_channel_memberships"
    )
    # The ACP session mode the agent will work in here, at most the registry's maximum for it. Read it through
    # `plane.chat.agents.effective_permission_level`: the registry's maximum may have come down since.
    permission_level = models.CharField(max_length=20, choices=AgentPermissionLevel.choices)

    class Meta:
        db_table = "chat_channel_agents"
        ordering = ("created_at",)
        constraints = [
            models.UniqueConstraint(fields=["channel", "agent"], condition=_ALIVE, name="chat_channel_agent_unique"),
        ]

    def save(self, *args, **kwargs):
        self.workspace_id = self.channel.workspace_id
        if self.channel.is_agent_dm:
            others = ChannelAgent.objects.filter(channel_id=self.channel_id).exclude(pk=self.pk)
            if others.exists() or str(self.agent_id) != self.channel.dm_key.rsplit(":", 1)[-1]:
                raise ValidationError("An agent DM has exactly one agent, fixed when it is opened.")
        elif self.channel.is_direct:
            raise ValidationError("Agents can't be added to a direct message.")
        super().save(*args, **kwargs)


class AgentDmSession(BaseModel):
    """The agent's ACP session behind an agent DM, so the agent bridge can pick it up again (`session/load`).

    `prompted_until` is when the newest message the agent has been given was sent: the next turn gives it the
    person's messages after that.
    """

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="chat_agent_dm_sessions")
    channel = models.OneToOneField("chat.Channel", on_delete=models.CASCADE, related_name="agent_session")
    session_ref = models.CharField(max_length=255, blank=True, default="")
    prompted_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_agent_dm_sessions"

    def save(self, *args, **kwargs):
        self.workspace_id = self.channel.workspace_id
        super().save(*args, **kwargs)


class AgentPermissionStatus(models.TextChoices):
    PENDING = "pending", "Waiting for an answer"
    ANSWERED = "answered", "Answered"
    EXPIRED = "expired", "Expired unanswered"


class AgentPermissionRequest(BaseModel):
    """A tool call the agent asked permission for during a turn in an agent DM, for the DM's person to answer.

    `request_id` is the agent bridge's, which is waiting for the answer. `options` are ACP's
    (`[{"option_id", "name", "kind"}]`). It expires with the turn.
    """

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="chat_agent_permissions")
    channel = models.ForeignKey("chat.Channel", on_delete=models.CASCADE, related_name="agent_permission_requests")
    run_id = models.CharField(max_length=32)
    request_id = models.CharField(max_length=32, unique=True)
    title = models.CharField(max_length=200, blank=True, default="")
    options = models.JSONField(default=list)
    status = models.CharField(
        max_length=16, choices=AgentPermissionStatus.choices, default=AgentPermissionStatus.PENDING
    )
    option_id = models.CharField(max_length=200, blank=True, default="")
    expires_at = models.DateTimeField()

    class Meta:
        db_table = "chat_agent_permission_requests"
        ordering = ("created_at",)
        indexes = [models.Index(fields=["channel", "status"], name="chat_agent_perm_channel_idx")]

    def save(self, *args, **kwargs):
        self.workspace_id = self.channel.workspace_id
        super().save(*args, **kwargs)
