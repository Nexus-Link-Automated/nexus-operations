# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Exporting a workspace's messages, for an instance admin.

In God mode an instance admin starts an export of one workspace (a `MessageExport`). `build_message_export` writes a
zip archive of JSON Lines files to the instance's storage, and an instance admin downloads it through a presigned URL
that lasts `DOWNLOAD_URL_SECONDS`. `delete_expired_exports` deletes the archive `CHAT_EXPORT_EXPIRY_HOURS` after it
was made; the record stays.

Public channels only, unless the export asks for private channels and direct messages as well. Archived channels are
in it; deleted ones aren't.

The archive:

    export.json     what was exported, when, by whom, and how much
    channels.jsonl  a channel per line
    members.jsonl   a channel membership per line: a person's (`member_type` "user"), or an agent's from the agent
                    registry ("agent": its ID, slug, name, permission level, whether the registry has it enabled, and
                    who added it)
    messages.jsonl  a message or thread reply (`parent_id`) per line, oldest first in each channel: the body as plain
                    text and as HTML, its timestamps, and its attachments' names, types and sizes, not the files
    users.jsonl     everyone in those lines: ID, display name and email
"""

import json
import tempfile
import zipfile
from collections import defaultdict
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from plane.chat.agents import effective_permission_level
from plane.chat.attachments import assets
from plane.chat.models import (
    Channel,
    ChannelAgent,
    ChannelKind,
    ChannelMember,
    Message,
    MessageExport,
    MessageExportStatus,
)
from plane.chat.retention import delete_storage_objects
from plane.db.models import User, Workspace
from plane.settings.storage import S3Storage
from plane.utils.exception_logger import log_exception

ARCHIVE_FORMAT = "nexus-messages-export"
ARCHIVE_VERSION = 1
# The download link is followed at once, so it only has to outlast the redirect.
DOWNLOAD_URL_SECONDS = 60
PAGE_SIZE = 1000


# Longer than any export takes; one queued or running for longer than this was lost.
STALE_EXPORT_HOURS = 6


def _iso(value):
    return value.isoformat() if value else None


def exported_kinds(include_private):
    if include_private:
        return [ChannelKind.PUBLIC, ChannelKind.PRIVATE, ChannelKind.DM, ChannelKind.GROUP_DM]
    return [ChannelKind.PUBLIC]


def _pages(queryset):
    """`queryset` in (created_at, id) order, `PAGE_SIZE` rows at a time, without holding a cursor open."""
    queryset = queryset.order_by("created_at", "id")
    last = None
    while True:
        page = queryset
        if last is not None:
            page = page.filter(Q(created_at__gt=last.created_at) | Q(created_at=last.created_at, id__gt=last.id))
        page = list(page[:PAGE_SIZE])
        if not page:
            return
        yield page
        last = page[-1]


def _write_lines(archive, name, rows):
    with archive.open(name, "w", force_zip64=True) as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False).encode() + b"\n")


def _channel_rows(channels):
    for channel in channels:
        yield {
            "id": str(channel.id),
            "kind": channel.kind,
            "name": channel.name,
            "description": channel.description,
            "project_id": str(channel.project_id) if channel.project_id else None,
            "created_at": _iso(channel.created_at),
            "archived_at": _iso(channel.archived_at),
        }


def _member_rows(channels, people):
    for page in _pages(ChannelMember.objects.filter(channel__in=channels)):
        for member in page:
            people.add(member.user_id)
            yield {
                "channel_id": str(member.channel_id),
                "member_type": "user",
                "user_id": str(member.user_id),
                "role": member.role,
                "joined_at": _iso(member.created_at),
            }
    for page in _pages(
        ChannelAgent.objects.filter(channel__in=channels, agent__deleted_at__isnull=True).select_related("agent")
    ):
        for member in page:
            if member.created_by_id:
                people.add(member.created_by_id)
            yield {
                "channel_id": str(member.channel_id),
                "member_type": "agent",
                "agent_id": str(member.agent_id),
                "agent_slug": member.agent.slug,
                "agent_name": member.agent.name,
                "permission_level": effective_permission_level(member),
                "is_available": member.agent.is_enabled,
                "added_by_id": str(member.created_by_id) if member.created_by_id else None,
                "joined_at": _iso(member.created_at),
            }


def _message_rows(channels, people, counts):
    for channel in channels:
        for page in _pages(Message.objects.filter(channel=channel)):
            files = defaultdict(list)
            held = assets().filter(entity_identifier__in=[str(message.id) for message in page]).order_by("created_at")
            for asset in held:
                files[asset.entity_identifier].append(
                    {
                        "id": str(asset.id),
                        "name": asset.attributes.get("name", ""),
                        "type": asset.attributes.get("type", ""),
                        "size": asset.attributes.get("size", 0),
                    }
                )
            for message in page:
                if message.sender_id:
                    people.add(message.sender_id)
                counts["messages"] += 1
                yield {
                    "id": str(message.id),
                    "channel_id": str(message.channel_id),
                    "parent_id": str(message.parent_id) if message.parent_id else None,
                    "sender_id": str(message.sender_id) if message.sender_id else None,
                    "sender_agent": message.sender_agent,
                    "system_event": message.system_event,
                    "body_text": message.body_stripped,
                    "body_html": message.body_html,
                    "created_at": _iso(message.created_at),
                    "edited_at": _iso(message.edited_at),
                    "removed_at": _iso(message.removed_at),
                    "attachments": files.get(str(message.id), []),
                }


def _user_rows(people):
    ids = sorted(people, key=str)
    for start in range(0, len(ids), PAGE_SIZE):
        users = User.objects.filter(pk__in=ids[start : start + PAGE_SIZE]).order_by("id")
        for user in users.only("id", "display_name", "email"):
            yield {"id": str(user.id), "display_name": user.display_name, "email": user.email}


def write_archive(file, workspace, export):
    """Write the archive of `workspace` that `export` asks for to `file`. Returns the channel and message counts."""
    channels = list(
        Channel.objects.filter(workspace=workspace, kind__in=exported_kinds(export.include_private)).order_by(
            "created_at", "id"
        )
    )
    people = set()
    counts = {"channels": len(channels), "messages": 0}
    with zipfile.ZipFile(file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        _write_lines(archive, "channels.jsonl", _channel_rows(channels))
        _write_lines(archive, "members.jsonl", _member_rows(channels, people))
        _write_lines(archive, "messages.jsonl", _message_rows(channels, people, counts))
        _write_lines(archive, "users.jsonl", _user_rows(people))
        summary = {
            "format": ARCHIVE_FORMAT,
            "version": ARCHIVE_VERSION,
            "export_id": str(export.id),
            "exported_at": _iso(timezone.now()),
            "requested_by": export.requested_by_email,
            "workspace": {"id": str(workspace.id), "slug": workspace.slug, "name": workspace.name},
            "include_private": export.include_private,
            "counts": counts,
        }
        archive.writestr("export.json", json.dumps(summary, ensure_ascii=False, indent=2))
    return counts


def storage_key(export):
    return f"chat-exports/{export.workspace_id}/{export.id}.zip"


def download_filename(export):
    return f"nexus-messages-{export.workspace_slug}-{export.created_at:%Y%m%d-%H%M}.zip"


@shared_task
def build_message_export(export_id):
    """Build a queued export's archive and put it in storage. A failure marks the export failed."""
    # Claimed with an update, so that a task delivered twice builds the archive once.
    if not MessageExport.objects.filter(pk=export_id, status=MessageExportStatus.QUEUED).update(
        status=MessageExportStatus.RUNNING
    ):
        return
    export = MessageExport.objects.get(pk=export_id)
    key = storage_key(export)
    try:
        workspace = Workspace.objects.get(pk=export.workspace_id)
        with tempfile.TemporaryFile() as file:
            counts = write_archive(file, workspace, export)
            size = file.tell()
            file.seek(0)
            if not S3Storage().upload_file(file, key, content_type="application/zip"):
                raise RuntimeError("The export archive could not be stored.")
    except Exception as error:
        log_exception(error)
        MessageExport.objects.filter(pk=export_id).update(
            status=MessageExportStatus.FAILED, completed_at=timezone.now()
        )
        return
    now = timezone.now()
    MessageExport.objects.filter(pk=export_id).update(
        status=MessageExportStatus.READY,
        storage_key=key,
        size=size,
        channel_count=counts["channels"],
        message_count=counts["messages"],
        completed_at=now,
        expires_at=now + timedelta(hours=settings.CHAT_EXPORT_EXPIRY_HOURS),
    )


def stale_before(now):
    """Exports queued or running since before this never finished: their worker was lost, or never got the task."""
    return now - timedelta(hours=STALE_EXPORT_HOURS)


@shared_task
def delete_expired_exports():
    """Delete the archives past their expiry from storage; their records stay, marked expired.

    An export stuck queued or running is marked failed, so it no longer blocks starting another.
    """
    now = timezone.now()
    MessageExport.objects.filter(
        status__in=[MessageExportStatus.QUEUED, MessageExportStatus.RUNNING], created_at__lt=stale_before(now)
    ).update(status=MessageExportStatus.FAILED, completed_at=now)
    for export in MessageExport.objects.filter(status=MessageExportStatus.READY, expires_at__lte=timezone.now()):
        try:
            delete_storage_objects([export.storage_key])
        except Exception as error:
            log_exception(error)
            continue
        MessageExport.objects.filter(pk=export.pk, status=MessageExportStatus.READY).update(
            status=MessageExportStatus.EXPIRED, storage_key=""
        )
