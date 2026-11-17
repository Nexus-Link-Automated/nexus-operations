# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""An EmployAI agent as a member of a workspace: a bot user with a workspace role and its own access token.

The bot is an ordinary `User` (`is_bot`, `bot_type` `EMPLOYAI`) with a `WorkspaceMember` row, so it is added to
projects, given a role and removed like any member, and everything it does goes through the public API or MCP with
its own token (scoped to this workspace). It cannot sign in to the web app. This row keeps what is only about the bot:
what it is for, and who made it.
"""

from django.db import models

from plane.db.models import BaseModel

__all__ = ["BOT_TYPE", "BotMember", "MAX_BOTS_PER_WORKSPACE"]

BOT_TYPE = "EMPLOYAI"
MAX_BOTS_PER_WORKSPACE = 20


class BotMember(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="bot_members")
    user = models.OneToOneField("db.User", on_delete=models.CASCADE, related_name="bot_member")
    description = models.TextField(blank=True, default="")

    class Meta:
        db_table = "coding_bot_members"
        ordering = ("created_at",)
