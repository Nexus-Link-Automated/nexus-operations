# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.app.serializers.base import BaseSerializer
from plane.chat.models import Channel
from plane.chat.search import MAX_QUERY_LENGTH, MIN_QUERY_LENGTH


class MessageSearchQuerySerializer(serializers.Serializer):
    """`search/`'s query. `automatic=false` leaves out automatic messages; `sender` is a person, so it does too."""

    q = serializers.CharField(
        min_length=MIN_QUERY_LENGTH,
        max_length=MAX_QUERY_LENGTH,
        error_messages={
            "blank": f"Type at least {MIN_QUERY_LENGTH} characters.",
            "required": f"Type at least {MIN_QUERY_LENGTH} characters.",
            "min_length": f"Type at least {MIN_QUERY_LENGTH} characters.",
            "max_length": f"Search for at most {MAX_QUERY_LENGTH} characters.",
        },
    )
    channel = serializers.UUIDField(required=False)
    sender = serializers.UUIDField(required=False)
    since = serializers.DateTimeField(required=False)
    until = serializers.DateTimeField(required=False)
    automatic = serializers.BooleanField(required=False, default=True)

    def validate(self, data):
        if "since" in data and "until" in data and data["since"] >= data["until"]:
            raise serializers.ValidationError({"until": ["until must be later than since."]})
        return data


class SearchChannelSerializer(BaseSerializer):
    """Enough of a result's channel to name it and link to it, archived ones included (the channel list omits those).

    Read the instance through `permissions.visible_channels`.
    """

    is_member = serializers.BooleanField(read_only=True)
    dm_member_ids = serializers.SerializerMethodField()

    class Meta:
        model = Channel
        fields = ["id", "kind", "name", "archived_at", "is_member", "dm_member_ids"]
        read_only_fields = fields

    def get_dm_member_ids(self, channel):
        return channel.dm_key.split(":") if channel.dm_key else []
