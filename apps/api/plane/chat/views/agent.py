# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agents as channel members: list, add and remove them (see `plane.chat.agents` for which ones and who may)."""

from django.db import IntegrityError, transaction
from rest_framework import status
from rest_framework.response import Response

from plane.chat.agents import available_agent, can_grant, default_permission_level
from plane.chat.events import EventType, agent_member_event, publish_on_commit
from plane.chat.exceptions import BadRequest, NotFound
from plane.chat.models import ChannelAgent
from plane.chat.permissions import (
    require_can_add_agents,
    require_channel_admin,
    require_named_channel,
    require_not_archived,
)
from plane.chat.serializers import ChannelAgentAddSerializer, ChannelAgentSerializer
from plane.chat.views.base import ChatBaseEndpoint

NO_AGENTS_IN_DMS = "Agents can't be added to a direct message."


def _channel_agents(channel):
    # The registry deletes agents for good; a soft deleted one is as good as gone.
    return (
        ChannelAgent.objects.filter(channel=channel, agent__deleted_at__isnull=True)
        .select_related("agent")
        .order_by("created_at", "id")
    )


class ChannelAgentEndpoint(ChatBaseEndpoint):
    def get(self, request, slug, channel_id):
        """The agents in a channel the caller can see, those disabled in the registry included and marked so."""
        channel = self.get_channel(channel_id)
        return Response(ChannelAgentSerializer(_channel_agents(channel), many=True).data)

    def post(self, request, slug, channel_id):
        """Add an agent from the registry: a channel admin or a workspace admin, never a guest.

        An agent already in the channel is left as it is (200). In a private channel the agent will be able to read
        what is said there; the web app says so before adding it.
        """
        channel = self.get_channel(channel_id)
        require_named_channel(channel, NO_AGENTS_IN_DMS)
        require_can_add_agents(channel, self.role)
        require_not_archived(channel)
        serializer = ChannelAgentAddSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        # One answer for an unknown agent and a disabled one: members are only ever shown the enabled ones.
        agent = available_agent(serializer.validated_data["agent_id"])
        if agent is None:
            raise BadRequest("This agent isn't available in this workspace.")
        level = serializer.validated_data.get("permission_level", default_permission_level(agent, channel))
        if not can_grant(agent, level, channel):
            raise BadRequest("This agent can't be given that permission level.")

        existing = _channel_agents(channel).filter(agent=agent).first()
        if existing is not None:
            return Response(ChannelAgentSerializer(existing).data)
        try:
            with transaction.atomic():
                added = ChannelAgent(channel=channel, agent=agent, permission_level=level)
                # Who added it, whatever request user the middleware recorded.
                added.save(created_by_id=request.user.id)
                publish_on_commit(agent_member_event(EventType.MEMBER_ADDED, added))
        except IntegrityError:
            # Someone added it at the same moment.
            return Response(ChannelAgentSerializer(_channel_agents(channel).get(agent=agent)).data)
        return Response(ChannelAgentSerializer(added).data, status=status.HTTP_201_CREATED)


class ChannelAgentDetailEndpoint(ChatBaseEndpoint):
    def delete(self, request, slug, channel_id, agent_id):
        """Remove an agent: a channel admin or a workspace admin, as for removing anyone else."""
        channel = self.get_channel(channel_id)
        require_named_channel(channel, NO_AGENTS_IN_DMS)
        require_channel_admin(channel, self.role)
        require_not_archived(channel)
        with transaction.atomic():
            current = ChannelAgent.objects.select_for_update().filter(channel=channel, agent_id=agent_id).first()
            if current is None:
                raise NotFound("This agent isn't in the channel.")
            current.delete()
            publish_on_commit(agent_member_event(EventType.MEMBER_REMOVED, current))
        return Response(status=status.HTTP_204_NO_CONTENT)
