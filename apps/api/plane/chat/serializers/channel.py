# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.app.serializers.base import BaseSerializer
from plane.chat.agents import agent_details, effective_permission_level
from plane.chat.models import GROUP_DM_MAX_MEMBERS, Channel, ChannelKind
from plane.chat.permissions import can_link_project
from plane.db.models import Project
from plane.license.models import AgentPermissionLevel

# The description is sent with every channel in every list, so it has to stay small.
MAX_DESCRIPTION_LENGTH = 2_000


class ChannelSerializer(BaseSerializer):
    """A channel as one caller sees it. Read the instance through `views.base.annotate_channels`."""

    is_member = serializers.BooleanField(read_only=True)
    my_role = serializers.CharField(read_only=True, allow_null=True)
    last_read_message_id = serializers.UUIDField(read_only=True, allow_null=True)
    # Top-level messages after my read cursor that are not removed and not mine; 0 if I'm not a member.
    unread_count = serializers.IntegerField(read_only=True)
    last_message_at = serializers.DateTimeField(read_only=True, allow_null=True)
    member_count = serializers.IntegerField(read_only=True)
    # Who is in a DM or group DM, so the client can name it; empty for named channels. An agent DM's person.
    dm_member_ids = serializers.SerializerMethodField()
    # An agent DM's agent, the level it works at there, whether it is replying, and why the DM is read-only.
    agent_dm = serializers.SerializerMethodField()

    class Meta:
        model = Channel
        fields = [
            "id",
            "workspace",
            "kind",
            "name",
            "description",
            "project",
            "archived_at",
            "created_by",
            "created_at",
            "updated_at",
            "is_member",
            "my_role",
            "last_read_message_id",
            "unread_count",
            "last_message_at",
            "member_count",
            "dm_member_ids",
            "agent_dm",
        ]
        read_only_fields = fields

    def get_dm_member_ids(self, channel):
        if channel.kind == ChannelKind.AGENT_DM:
            from plane.chat.agent_dm import dm_person_id

            return [dm_person_id(channel)]
        return channel.dm_key.split(":") if channel.dm_key else []

    def get_agent_dm(self, channel):
        if channel.kind != ChannelKind.AGENT_DM:
            return None
        from plane.chat.agent_dm import dm_channel_agent, is_responding, read_only_reason

        row = dm_channel_agent(channel)
        agent = row.agent if row is not None and row.agent.deleted_at is None else None
        return {
            "agent": agent_details(agent),
            "permission_level": effective_permission_level(row) if agent else None,
            "default_permission_level": agent.default_permission_level if agent else None,
            "max_permission_level": agent.max_permission_level if agent else None,
            "responding": is_responding(channel.id),
            "read_only_reason": read_only_reason(channel, row),
        }


class ChannelUpdateSerializer(BaseSerializer):
    """Renaming a public or private channel, editing its description, or linking it to a project.

    Needs `workspace_id` and `user` in the context: names are unique within the workspace, and a channel can
    only be linked to a project the caller is a member of (`can_link_project`).
    """

    project = serializers.PrimaryKeyRelatedField(
        queryset=Project.objects.all(),
        required=False,
        allow_null=True,
        # The same message as `validate_project`, so an unknown ID and another workspace's look alike.
        error_messages={"does_not_exist": "Project not found."},
    )

    class Meta:
        model = Channel
        fields = ["name", "description", "project"]
        extra_kwargs = {"description": {"max_length": MAX_DESCRIPTION_LENGTH}}

    def validate_name(self, value):
        name = value.strip()
        if not name:
            raise serializers.ValidationError("A channel needs a name.")
        others = Channel.objects.filter(
            workspace_id=self.context["workspace_id"], kind__in=(ChannelKind.PUBLIC, ChannelKind.PRIVATE)
        ).filter(name__iexact=name)
        if self.instance is not None:
            others = others.exclude(pk=self.instance.pk)
        if others.exists():
            raise serializers.ValidationError("A channel with this name already exists.")
        return name

    def validate_project(self, project):
        # Keeping the link it has is fine: an admin who isn't in the project can still rename the channel.
        if project is None or (self.instance is not None and self.instance.project_id == project.pk):
            return project
        if not can_link_project(self.context["user"], project, self.context["workspace_id"]):
            # The same message whether the project is elsewhere or just not yours, so it doesn't leak.
            raise serializers.ValidationError("Project not found.")
        return project


class ChannelCreateSerializer(ChannelUpdateSerializer):
    """Creating a public or private channel, optionally linked to a project. DMs are opened through `dms/` instead."""

    kind = serializers.ChoiceField(
        choices=[ChannelKind.PUBLIC, ChannelKind.PRIVATE], required=False, default=ChannelKind.PUBLIC
    )

    class Meta(ChannelUpdateSerializer.Meta):
        fields = ["name", "description", "kind", "project"]
        extra_kwargs = {**ChannelUpdateSerializer.Meta.extra_kwargs, "name": {"required": True}}


class DirectMessageOpenSerializer(serializers.Serializer):
    """The other people in a DM (one) or a group DM (two or more). The caller is always included.

    Listing the caller too is allowed, so the cap is the whole group's; the manager enforces the exact size.
    """

    member_ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=GROUP_DM_MAX_MEMBERS)


class AgentDmOpenSerializer(serializers.Serializer):
    """The registry's agent to open (or reopen) the caller's agent DM with."""

    agent_id = serializers.UUIDField()


class AgentDmUpdateSerializer(serializers.Serializer):
    """The level the agent works at in the DM, up to the registry's maximum for it."""

    permission_level = serializers.ChoiceField(choices=AgentPermissionLevel.choices)


class AgentPermissionAnswerSerializer(serializers.Serializer):
    option_id = serializers.CharField(max_length=200)
