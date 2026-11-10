# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.chat.agents import effective_permission_level
from plane.license.models import AgentPermissionLevel


class ChannelAgentSerializer(serializers.Serializer):
    """An agent in a channel, as anyone who can see the channel sees it. Read it with `select_related("agent")`.

    Only what a workspace member may already see of the agent in `workspaces/<slug>/agents/`, never its configuration.
    """

    id = serializers.UUIDField(read_only=True)
    channel = serializers.UUIDField(source="channel_id", read_only=True)
    agent = serializers.UUIDField(source="agent_id", read_only=True)
    slug = serializers.CharField(source="agent.slug", read_only=True)
    name = serializers.CharField(source="agent.name", read_only=True)
    description = serializers.CharField(source="agent.description", read_only=True)
    adapter = serializers.CharField(source="agent.adapter", read_only=True)
    permission_level = serializers.SerializerMethodField()
    # Disabled in the registry: still listed, but nothing reaches it until it is enabled again.
    is_available = serializers.BooleanField(source="agent.is_enabled", read_only=True)
    added_by = serializers.UUIDField(source="created_by_id", read_only=True, allow_null=True)
    added_at = serializers.DateTimeField(source="created_at", read_only=True)

    def get_permission_level(self, channel_agent):
        return effective_permission_level(channel_agent)


class ChannelAgentAddSerializer(serializers.Serializer):
    """An agent from the registry, and the level it works at in the channel (its registry default if left out)."""

    agent_id = serializers.UUIDField()
    permission_level = serializers.ChoiceField(choices=AgentPermissionLevel.choices, required=False)
