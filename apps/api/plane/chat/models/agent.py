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

DMs and group DMs never have agents. `save()` refuses it, and so does the database (migration 0009's trigger).
"""

from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q

from plane.db.models import BaseModel
from plane.license.models import AgentPermissionLevel

__all__ = ["ChannelAgent"]

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
        if self.channel.is_direct:
            raise ValidationError("Agents can't be added to a direct message.")
        super().save(*args, **kwargs)
