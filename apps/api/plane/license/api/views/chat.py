# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""God mode's Messages settings: how long messages are kept, and exports of a workspace's messages.

Instance admins only. Workspace admins can't export in this version.
"""

# Django imports
from django.conf import settings
from django.db import transaction
from django.utils import timezone

# Third party imports
from rest_framework import serializers, status
from rest_framework.response import Response

# Module imports
from plane.chat.export import DOWNLOAD_URL_SECONDS, build_message_export, download_filename, stale_before
from plane.chat.models import MessageExport, MessageExportStatus
from plane.chat.retention import (
    MAX_RETENTION_DAYS,
    MIN_RETENTION_DAYS,
    RETENTION_DAYS_HELP,
    RETENTION_KEY,
    parse_retention_days,
    retention_days,
)
from plane.db.models import Workspace
from plane.license.api.permissions import InstanceAdminPermission
from plane.license.models import InstanceConfiguration
from plane.settings.storage import S3Storage
from .base import BaseAPIView

# How many past exports the list shows.
EXPORT_LIST_LIMIT = 50


def _settings_payload():
    return {
        "retention_days": retention_days(),
        "min_retention_days": MIN_RETENTION_DAYS,
        "max_retention_days": MAX_RETENTION_DAYS,
        "export_expiry_hours": settings.CHAT_EXPORT_EXPIRY_HOURS,
        # Read only here: they are set with CHAT_RATE_LIMIT_<NAME> environment variables.
        "rate_limits": {name: rate.split(",") for name, rate in settings.CHAT_RATE_LIMITS.items()},
        # Set with CHAT_AGENT_REPLY_TIMEOUT_SECONDS.
        "agent_reply_timeout_seconds": settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS,
    }


class InstanceChatSettingsEndpoint(BaseAPIView):
    permission_classes = [InstanceAdminPermission]

    def get(self, request):
        return Response(_settings_payload())

    def patch(self, request):
        """Set `retention_days`: 0 keeps messages forever, else `MIN_RETENTION_DAYS` to `MAX_RETENTION_DAYS`."""
        if "retention_days" not in request.data:
            return Response({"error": "retention_days is required."}, status=status.HTTP_400_BAD_REQUEST)
        value = request.data["retention_days"]
        try:
            # A bool is an int in Python, and null would read as "forever": neither is a number of days.
            if value is None or isinstance(value, bool):
                raise ValueError("Enter a whole number of days.")
            days = parse_retention_days(value)
        except ValueError:
            return Response({"error": RETENTION_DAYS_HELP}, status=status.HTTP_400_BAD_REQUEST)
        InstanceConfiguration.objects.update_or_create(
            key=RETENTION_KEY, defaults={"value": str(days), "category": "CHAT", "is_encrypted": False}
        )
        return Response(_settings_payload())


class MessageExportSerializer(serializers.ModelSerializer):
    workspace_id = serializers.UUIDField(read_only=True)
    requested_by_id = serializers.UUIDField(read_only=True)
    can_download = serializers.SerializerMethodField()

    class Meta:
        model = MessageExport
        fields = [
            "id",
            "workspace_id",
            "workspace_slug",
            "workspace_name",
            "requested_by_id",
            "requested_by_email",
            "include_private",
            "status",
            "size",
            "channel_count",
            "message_count",
            "created_at",
            "completed_at",
            "expires_at",
            "can_download",
        ]
        read_only_fields = fields

    def get_can_download(self, export):
        return _downloadable(export)


def _downloadable(export):
    return (
        export.status == MessageExportStatus.READY
        and bool(export.storage_key)
        and export.expires_at is not None
        and export.expires_at > timezone.now()
    )


class MessageExportCreateSerializer(serializers.Serializer):
    workspace_id = serializers.UUIDField()
    include_private = serializers.BooleanField(default=False)


class InstanceMessageExportEndpoint(BaseAPIView):
    permission_classes = [InstanceAdminPermission]

    def get(self, request):
        exports = MessageExport.objects.order_by("-created_at")[:EXPORT_LIST_LIMIT]
        return Response(MessageExportSerializer(exports, many=True).data)

    def post(self, request):
        """Export a workspace's public channels, or with `include_private` its private channels and DMs as well."""
        serializer = MessageExportCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        workspace = Workspace.objects.filter(pk=data["workspace_id"]).first()
        if workspace is None:
            return Response({"error": "Workspace not found."}, status=status.HTTP_404_NOT_FOUND)
        with transaction.atomic():
            # Locked, so two requests at once can't both start one.
            Workspace.objects.select_for_update().filter(pk=workspace.pk).first()
            in_progress = MessageExport.objects.filter(
                workspace=workspace,
                status__in=[MessageExportStatus.QUEUED, MessageExportStatus.RUNNING],
                created_at__gte=stale_before(timezone.now()),
            )
            if in_progress.exists():
                return Response(
                    {"error": "An export of this workspace is already in progress."},
                    status=status.HTTP_409_CONFLICT,
                )
            export = MessageExport.objects.create(
                workspace=workspace,
                workspace_slug=workspace.slug,
                workspace_name=workspace.name,
                requested_by=request.user,
                requested_by_email=request.user.email,
                include_private=data["include_private"],
            )
            transaction.on_commit(lambda: build_message_export.delay(str(export.id)))
        return Response(MessageExportSerializer(export).data, status=status.HTTP_201_CREATED)


class InstanceMessageExportDownloadEndpoint(BaseAPIView):
    permission_classes = [InstanceAdminPermission]

    def get(self, request, pk):
        """A presigned URL for the archive, valid for `DOWNLOAD_URL_SECONDS`. 404 once it has expired."""
        export = MessageExport.objects.filter(pk=pk).first()
        if export is None or not _downloadable(export):
            return Response({"error": "This export can't be downloaded."}, status=status.HTTP_404_NOT_FOUND)
        url = S3Storage(request=request).generate_presigned_url(
            object_name=export.storage_key,
            expiration=DOWNLOAD_URL_SECONDS,
            disposition="attachment",
            filename=download_filename(export),
            content_type="application/zip",
        )
        if not url:
            return Response(
                {"error": "The download link couldn't be made."}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        response = Response({"url": url, "expires_in": DOWNLOAD_URL_SECONDS})
        response["Cache-Control"] = "no-store"
        return response
