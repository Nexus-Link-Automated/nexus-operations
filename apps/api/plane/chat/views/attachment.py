# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""attachments/: uploading a file for a message, and fetching one (see `plane.chat.attachments`).

Every refusal here is the same 404, for a file that isn't there and for someone who isn't in the channel alike.
"""

import uuid

from django.conf import settings
from django.db import transaction
from django.http import HttpResponseRedirect
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.bgtasks.storage_metadata_task import get_asset_object_metadata
from plane.chat.attachments import SIGNED_URL_SECONDS, assets, clean_filename, is_on
from plane.chat.exceptions import NotFound
from plane.chat.models import Message
from plane.chat.permissions import require_not_archived, visible_channels
from plane.chat.serializers import AttachmentUploadSerializer
from plane.chat.views.base import ChatBaseEndpoint
from plane.db.models import FileAsset
from plane.settings.storage import S3Storage

NOT_FOUND = "Attachment not found."


class _AttachmentEndpoint(ChatBaseEndpoint):
    def member_channel(self, channel_id):
        """The channel, for a member only. Workspace admins and readers of a public channel must join first."""
        channel = (
            visible_channels(self.request.user, self.workspace_slug, self.role)
            .filter(pk=channel_id, is_member=True)
            .first()
        )
        if channel is None:
            raise NotFound(NOT_FOUND)
        return channel


class AttachmentEndpoint(_AttachmentEndpoint):
    rate_limits = {"POST": "upload"}

    def post(self, request, slug, channel_id):
        """A presigned POST to upload one file for this channel."""
        channel = self.member_channel(channel_id)
        require_not_archived(channel)
        serializer = AttachmentUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # The key holds no part of the filename: nothing in it is the user's to choose.
        asset_key = f"{channel.workspace_id}/{uuid.uuid4().hex}"
        asset = FileAsset.objects.create(
            attributes={
                "name": clean_filename(data["name"]),
                "type": data["type"],
                "size": data["size"],
                "channel_id": str(channel.id),
            },
            asset=asset_key,
            size=data["size"],
            workspace_id=channel.workspace_id,
            created_by=request.user,
            entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT,
        )
        upload_data = S3Storage(request=request).generate_presigned_post(
            object_name=asset_key, file_type=data["type"], file_size=data["size"]
        )
        return Response({"upload_data": upload_data, "asset_id": str(asset.id)}, status=status.HTTP_201_CREATED)


class AttachmentDetailEndpoint(_AttachmentEndpoint):
    def _own_unsent(self, request, channel, asset_id):
        """The caller's own upload for this channel, not yet on a message.

        Locked, as `claim_attachments` locks it, so a send can't claim it while it is being discarded: whichever
        comes second sees the other's outcome. Call inside a transaction.
        """
        asset = (
            assets()
            .select_for_update()
            .filter(
                pk=asset_id,
                workspace_id=channel.workspace_id,
                created_by=request.user,
                entity_identifier__isnull=True,
                attributes__channel_id=str(channel.id),
            )
            .first()
        )
        if asset is None:
            raise NotFound(NOT_FOUND)
        return asset

    def get(self, request, slug, channel_id, asset_id):
        """Redirect to the file: inline for a raster image asked for with `?preview=1`, otherwise as a download."""
        channel = self.member_channel(channel_id)
        asset = assets().filter(pk=asset_id, workspace_id=channel.workspace_id, is_uploaded=True).first()
        message = (
            Message.objects.filter(pk=asset.entity_identifier, channel=channel, removed_at__isnull=True).first()
            if asset is not None and asset.entity_identifier is not None
            else None
        )
        # A file on a message in another channel, or one not yet on a message at all, is no more found than a typo.
        if message is None or not is_on(asset, message):
            raise NotFound(NOT_FOUND)

        file_type = asset.attributes.get("type")
        inline = "preview" in request.query_params and file_type in settings.INLINE_SAFE_MIME_TYPES
        # S3Storage only honours inline for an allow-listed type, which it also pins on the response.
        signed_url = S3Storage(request=request).generate_presigned_url(
            object_name=asset.asset.name,
            expiration=SIGNED_URL_SECONDS,
            disposition="inline" if inline else "attachment",
            filename=asset.attributes.get("name"),
            content_type=file_type,
        )
        response = HttpResponseRedirect(signed_url)
        # Never reused: the next look at this file checks membership again.
        response["Cache-Control"] = "no-store"
        return response

    def patch(self, request, slug, channel_id, asset_id):
        """The upload finished. Until this, the file can't go on a message."""
        channel = self.member_channel(channel_id)
        with transaction.atomic():
            asset = self._own_unsent(request, channel, asset_id)
            newly_finished = not asset.is_uploaded
            if newly_finished:
                asset.is_uploaded = True
                asset.save(update_fields=["is_uploaded"])
        if newly_finished:
            get_asset_object_metadata.delay(str(asset.id))
        return Response(status=status.HTTP_204_NO_CONTENT)

    def delete(self, request, slug, channel_id, asset_id):
        """Discard an upload that hasn't been sent."""
        channel = self.member_channel(channel_id)
        with transaction.atomic():
            asset = self._own_unsent(request, channel, asset_id)
            asset.is_deleted = True
            asset.deleted_at = timezone.now()
            asset.save(update_fields=["is_deleted", "deleted_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)
