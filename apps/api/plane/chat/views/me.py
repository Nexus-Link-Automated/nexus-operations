# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What the caller may do in this workspace's chat, so the web app can show or hide its controls.

It also carries the workspace ID: the chat gateway reads it here to admit a socket, and to know which Redis
channel to follow, in one call that only an active member of the workspace gets an answer from.
"""

from django.conf import settings
from rest_framework.response import Response

from plane.chat.agents import can_add_agents
from plane.chat.permissions import can_create_channels, can_open_dms, is_workspace_admin
from plane.chat.views.base import ChatBaseEndpoint


class ChatMeEndpoint(ChatBaseEndpoint):
    def get(self, request, slug):
        """The caller's workspace role and chat abilities. The other endpoints enforce the same rules."""
        return Response(
            {
                "workspace_id": str(self.workspace.id),
                "workspace_role": self.role,
                "is_workspace_admin": is_workspace_admin(self.role),
                "can_create_channels": can_create_channels(self.role),
                "can_open_dms": can_open_dms(request.user, self.workspace.id, self.role),
                # In a channel they administer, or any channel as a workspace admin.
                "can_add_agents": can_add_agents(self.role),
                # Who may run agents may also set them off with a mention, in a channel they are in.
                "can_mention_agents": can_add_agents(self.role),
                # How long an agent may work on a mention; the web app stops showing it as working after this.
                "agent_reply_timeout_seconds": settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS,
            }
        )
