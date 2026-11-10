# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from .base import BaseSerializer
from plane.db.models import FileAsset


class FileAssetSerializer(BaseSerializer):
    class Meta:
        model = FileAsset
        fields = "__all__"
        read_only_fields = ["created_by", "updated_by", "created_at", "updated_at"]

    def validate_entity_type(self, value):
        # Message attachments are made only by plane.chat, which checks channel membership.
        if value == FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT:
            raise serializers.ValidationError("This entity type can't be set here.")
        return value
