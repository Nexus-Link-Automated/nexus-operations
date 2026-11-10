# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent DMs: open one, change the agent's level in it, stop its turn, and answer its permission prompts.

See `plane.chat.agent_dm`. Only the DM's person can see an agent DM, so everyone else gets a 404 here.
"""

from rest_framework import status
from rest_framework.response import Response

from plane.chat.agent_dm import (
    READ_ONLY_MESSAGES,
    BridgeUnavailable,
    PermissionGone,
    TurnNotRunning,
    UnknownOption,
    answer_permission,
    dm_channel_agent,
    draft_id,
    pending_permissions,
    read_only_reason,
    stop_turn,
)
from plane.chat.agents import available_agent, can_add_agents, can_grant
from plane.chat.exceptions import BadRequest, Conflict, Forbidden, NotFound
from plane.chat.models import AgentPermissionRequest, Channel
from plane.chat.serializers import (
    AgentDmOpenSerializer,
    AgentDmUpdateSerializer,
    AgentPermissionAnswerSerializer,
)
from plane.chat.views.base import ChatBaseEndpoint
from plane.chat.views.channel import ChannelPayloadMixin

UNAVAILABLE = "The agent service is unavailable. Try again in a moment."


class AgentDmMixin:
    def get_agent_dm(self, channel_id):
        """The caller's agent DM; 404 if they can't see it or it isn't an agent DM."""
        channel = self.get_channel(channel_id)
        if not channel.is_agent_dm or channel.membership is None:
            raise NotFound("Agent DM not found.")
        return channel


class AgentDmEndpoint(ChannelPayloadMixin, ChatBaseEndpoint):
    rate_limits = {"POST": "channel"}

    def post(self, request, slug):
        """Open the caller's DM with an agent from the registry, creating it at the agent's default level if needed.

        Workspace admins and members can; guests can't run agents, so they can't. The agent must be enabled.
        """
        if not can_add_agents(self.role):
            raise Forbidden("Guests can't use agents.")
        serializer = AgentDmOpenSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        agent = available_agent(serializer.validated_data["agent_id"])
        if agent is None:
            raise BadRequest("This agent isn't available in this workspace.")
        channel, created = Channel.objects.get_or_create_agent_dm(
            self.workspace, request.user, agent, agent.default_permission_level
        )
        return Response(
            self.channel_payload(channel.id), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK
        )


class AgentDmDetailEndpoint(AgentDmMixin, ChannelPayloadMixin, ChatBaseEndpoint):
    def patch(self, request, slug, channel_id):
        """Change the agent's level in the DM, up to the registry's maximum. It applies from the next turn."""
        channel = self.get_agent_dm(channel_id)
        row = dm_channel_agent(channel)
        reason = read_only_reason(channel, row)
        if reason is not None:
            raise Conflict(READ_ONLY_MESSAGES[reason])
        serializer = AgentDmUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        level = serializer.validated_data["permission_level"]
        if not can_grant(row.agent, level):
            raise BadRequest("This agent can't be given that permission level.")
        if row.permission_level != level:
            row.permission_level = level
            row.save(update_fields=["permission_level", "updated_at", "updated_by"])
        return Response(self.channel_payload(channel.id))


class AgentDmStopEndpoint(AgentDmMixin, ChatBaseEndpoint):
    def post(self, request, slug, channel_id):
        """Stop the agent's running turn. What it wrote so far stays."""
        channel = self.get_agent_dm(channel_id)
        try:
            stop_turn(channel)
        except TurnNotRunning:
            raise Conflict("The agent isn't working on anything.")
        except BridgeUnavailable:
            return Response({"error": UNAVAILABLE}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"stopped": True}, status=status.HTTP_202_ACCEPTED)


def _permission_payload(request):
    return {
        "id": request.request_id,
        "title": request.title,
        "options": request.options,
        "message_id": draft_id(request.run_id),
        "expires_at": request.expires_at,
    }


class AgentDmPermissionEndpoint(AgentDmMixin, ChatBaseEndpoint):
    def get(self, request, slug, channel_id):
        """The agent's permission prompts in the DM still waiting for an answer."""
        channel = self.get_agent_dm(channel_id)
        return Response([_permission_payload(item) for item in pending_permissions(channel)])


class AgentDmPermissionDetailEndpoint(AgentDmMixin, ChatBaseEndpoint):
    def post(self, request, slug, channel_id, request_id):
        """Answer a permission prompt with one of its options: the DM's person only, while it is still pending."""
        channel = self.get_agent_dm(channel_id)
        serializer = AgentPermissionAnswerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        option_id = serializer.validated_data["option_id"]
        try:
            answered = answer_permission(channel, request_id, option_id)
        except AgentPermissionRequest.DoesNotExist:
            raise NotFound("Permission request not found.")
        except PermissionGone:
            raise Conflict("This request is no longer waiting for an answer.")
        except UnknownOption:
            raise BadRequest("option_id is not one of the request's options.")
        except BridgeUnavailable:
            return Response({"error": UNAVAILABLE}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"id": answered.request_id, "status": answered.status, "option_id": answered.option_id})
