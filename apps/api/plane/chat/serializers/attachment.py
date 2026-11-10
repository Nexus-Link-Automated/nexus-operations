# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.conf import settings
from rest_framework import serializers


class AttachmentUploadSerializer(serializers.Serializer):
    """What the client says about a file it wants to upload. The presigned POST holds it to `type` and `size`."""

    name = serializers.CharField(max_length=2000)
    type = serializers.CharField(max_length=255)
    size = serializers.IntegerField(min_value=1)

    def validate_type(self, value):
        if value not in settings.ATTACHMENT_MIME_TYPES:
            raise serializers.ValidationError("This file type isn't allowed.")
        return value

    def validate_size(self, value):
        if value > settings.FILE_SIZE_LIMIT:
            raise serializers.ValidationError("This file is too large.")
        return value
