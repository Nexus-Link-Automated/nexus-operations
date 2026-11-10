# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Files attached to messages.

An attachment is a `FileAsset` of entity type CHAT_MESSAGE_ATTACHMENT, uploaded the way Plane's issue
attachments are: the client asks for a presigned POST (`attachments/`), sends the file to storage, and
says it finished (`PATCH attachments/<id>/`). Sending a message with `attachment_ids` then claims it:

    attributes["channel_id"]  the channel it was uploaded for, from the start
    entity_identifier         the message, once claimed; NULL until then

Only channel members can reach a file, checked on every request, so being removed from a channel ends
access at once: the API never hands out a storage URL, only a link to an endpoint that checks and then
redirects to a presigned one that expires within a minute. Other than that endpoint, a file can't be read:
one not yet claimed is visible to nobody, its uploader included (the composer already holds it locally).
"""

import os
import unicodedata
from collections import defaultdict

from django.conf import settings

from plane.chat.exceptions import BadRequest
from plane.chat.models import ChannelMember
from plane.db.models import FileAsset
from plane.utils.path_validator import sanitize_filename

MAX_ATTACHMENTS_PER_MESSAGE = 10
MAX_FILENAME_LENGTH = 255
# How long a redirect to storage works for: it is followed at once, so it only has to outlast the redirect.
SIGNED_URL_SECONDS = 60


def assets():
    """Message attachments that haven't been deleted."""
    return FileAsset.objects.filter(entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT, is_deleted=False)


def clean_filename(name):
    """A filename safe to store and hand back, or "unnamed".

    `sanitize_filename` strips paths and control characters. Format characters go too, since right-to-left
    overrides can make `exe` read as something else in the name a person is shown.
    """
    without_format_chars = "".join(char for char in name if unicodedata.category(char) != "Cf")
    cleaned = sanitize_filename(without_format_chars) or "unnamed"
    if len(cleaned) <= MAX_FILENAME_LENGTH:
        return cleaned
    stem, extension = os.path.splitext(cleaned)
    if len(extension) >= MAX_FILENAME_LENGTH:
        return cleaned[:MAX_FILENAME_LENGTH]
    return stem[: MAX_FILENAME_LENGTH - len(extension)] + extension


def claim_attachments(message, asset_ids, user):
    """Attach finished uploads to `message`, or refuse the lot (400) if any isn't this sender's to attach.

    Each must be the sender's own upload for this channel, finished, and not already on a message. Locked so
    that two messages can't claim the same file. Call it inside the transaction that creates the message.
    """
    wanted = set(asset_ids)
    if not wanted:
        return
    claimable = list(
        assets()
        .select_for_update()
        .filter(
            pk__in=wanted,
            workspace_id=message.workspace_id,
            created_by=user,
            is_uploaded=True,
            entity_identifier__isnull=True,
            attributes__channel_id=str(message.channel_id),
        )
    )
    if len(claimable) != len(wanted):
        raise BadRequest("One or more attachments can't be added to this message.")
    for asset in claimable:
        asset.entity_identifier = str(message.pk)
    FileAsset.objects.bulk_update(claimable, ["entity_identifier"])


def _attributes(asset):
    return asset.attributes if isinstance(asset.attributes, dict) else {}


def is_on(asset, message):
    """Whether `asset` really is one of `message`'s files: a finished upload its sender made for its channel.

    `claim_attachments` only ever claims such files. Checked again on every read so that a row made some
    other way, pointing at a message it was never sent with, is not shown or served as part of it.
    """
    return (
        message.sender_id is not None
        and asset.entity_identifier == str(message.pk)
        and asset.is_uploaded
        and asset.workspace_id == message.workspace_id
        and asset.created_by_id == message.sender_id
        and _attributes(asset).get("channel_id") == str(message.channel_id)
    )


def has_attachments(message):
    return any(is_on(asset, message) for asset in assets().filter(entity_identifier=str(message.pk)))


def _describe(asset, message):
    base = f"/api/workspaces/{asset.workspace.slug}/chat/channels/{message.channel_id}/attachments/{asset.id}/"
    attributes = _attributes(asset)
    file_type = attributes.get("type", "")
    return {
        "id": str(asset.id),
        "name": attributes.get("name", ""),
        "type": file_type,
        "size": attributes.get("size", 0),
        # Set only for the raster types the endpoint serves inline; anything else can only be downloaded.
        "preview_url": f"{base}?preview=1" if file_type in settings.INLINE_SAFE_MIME_TYPES else None,
        "download_url": base,
    }


def attachments_for(messages, user):
    """For each of `messages` that has attachments: their `count`, and the `files` if `user` is in its channel.

    A reader who isn't in the channel (of a public one they can browse, say) gets the count and no files.
    """
    held = defaultdict(list)
    rows = (
        assets()
        .filter(entity_identifier__in=[str(message.id) for message in messages])
        .select_related("workspace")
        .order_by("created_at", "id")
    )
    by_id = {str(message.id): message for message in messages}
    for asset in rows:
        if is_on(asset, by_id[asset.entity_identifier]):
            held[asset.entity_identifier].append(asset)
    if not held:
        return {}
    member_of = set(
        ChannelMember.objects.filter(
            user=user, channel_id__in={message.channel_id for message in messages}
        ).values_list("channel_id", flat=True)
    )
    return {
        message.id: {
            "count": len(held[str(message.id)]),
            "files": (
                [_describe(asset, message) for asset in held[str(message.id)]]
                if message.channel_id in member_of
                else []
            ),
        }
        for message in messages
        if str(message.id) in held
    }
