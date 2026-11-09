# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""@mentions in messages become entries in Plane's inbox.

Mentions are found the way work item comments find theirs. Someone is notified only
if they could open the message: a mention can't tell anyone a private channel or a DM
exists. A channel set to "Nothing" gets no entry.

The entry is a snapshot, so what the inbox lists is checked when it is read: an entry
disappears once its message is removed or its receiver can no longer see the channel.
"""

import html
import uuid

from django.db import transaction
from django.db.models import Exists, OuterRef, Q

from plane.bgtasks.notification_task import get_new_comment_mentions
from plane.chat.models import ChannelKind, ChannelMember, ChannelNotificationLevel, Message
from plane.chat.permissions import can_browse_public_channels
from plane.db.models import Notification, WorkspaceMember
from plane.utils.exception_logger import log_exception

CHAT_MESSAGE_ENTITY = "chat_message"
CHAT_MENTION_SENDER = "in_app:chat:mentioned"
PREVIEW_LENGTH = 200


def _user_ids(raw_ids):
    """The valid UUIDs in `raw_ids`, which come from HTML the sender wrote."""
    ids = set()
    for raw in raw_ids:
        try:
            ids.add(uuid.UUID(str(raw)))
        except ValueError:
            continue
    return ids


def _who_can_see(message, candidates):
    """Those of `candidates` who can open `message`, each with their level in its channel (None if not in it)."""
    roles = dict(
        WorkspaceMember.objects.filter(
            workspace_id=message.workspace_id, member_id__in=candidates, is_active=True, member__is_active=True
        ).values_list("member_id", "role")
    )
    levels = dict(
        ChannelMember.objects.filter(channel_id=message.channel_id, user_id__in=roles).values_list(
            "user_id", "notification_level"
        )
    )
    is_public = message.channel.kind == ChannelKind.PUBLIC
    return {
        user_id: levels.get(user_id)
        for user_id, role in roles.items()
        if user_id in levels or (is_public and can_browse_public_channels(role))
    }


def _recipients(message, candidates):
    """Those of `candidates` who can see `message` and haven't muted its channel."""
    return [
        user_id
        for user_id, level in _who_can_see(message, candidates).items()
        if user_id != message.sender_id and level != ChannelNotificationLevel.NONE
    ]


def _entries(message):
    return Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY, entity_identifier=message.id)


def _data(message):
    channel = message.channel
    return {
        "chat_message": {
            "id": str(message.id),
            "channel_id": str(channel.id),
            "channel_name": channel.name,
            "channel_kind": channel.kind,
            "parent_id": str(message.parent_id) if message.parent_id else None,
            # `body_stripped` keeps HTML entities, and the inbox shows this as plain text.
            "preview": html.unescape(message.body_stripped).strip()[:PREVIEW_LENGTH],
        }
    }


def _notify(message, previous_html):
    mentioned = _user_ids(get_new_comment_mentions(message.body_html, previous_html))
    if not mentioned:
        return
    already_notified = set(_entries(message).filter(receiver_id__in=mentioned).values_list("receiver_id", flat=True))
    actor_name = message.sender.display_name if message.sender else message.sender_agent
    title = f"{actor_name} mentioned you in a message"
    data = _data(message)
    Notification.objects.bulk_create(
        [
            Notification(
                workspace_id=message.workspace_id,
                entity_identifier=message.id,
                entity_name=CHAT_MESSAGE_ENTITY,
                title=title,
                sender=CHAT_MENTION_SENDER,
                triggered_by_id=message.sender_id,
                receiver_id=receiver_id,
                data=data,
            )
            for receiver_id in _recipients(message, mentioned - already_notified)
        ],
        batch_size=100,
    )


def notify_mentions(message, previous_html=None):
    """Add an inbox entry for everyone newly mentioned in `message`. The message is already saved, so never raises."""
    try:
        # A savepoint: callers may be inside a transaction, which a failed query here would otherwise abort.
        with transaction.atomic():
            _notify(message, previous_html)
    except Exception as error:
        log_exception(error)


def refresh_mention_previews(message):
    """Keep inbox entries in step with an edit or a removal, so text its author took back doesn't linger there.

    New text only reaches people who can still open the message; a removal blanks every entry.
    """
    try:
        with transaction.atomic():
            entries = _entries(message)
            if message.removed_at is None:
                receivers = list(entries.values_list("receiver_id", flat=True))
                entries = entries.filter(receiver_id__in=list(_who_can_see(message, receivers)))
            entries.update(data=_data(message))
    except Exception as error:
        log_exception(error)


def visible_chat_mentions(user_id, role):
    """A filter for the chat entries `user_id` may still see in the inbox; `role` is their workspace role."""
    can_see = Q(Exists(ChannelMember.objects.filter(channel=OuterRef("channel"), user_id=user_id)))
    if can_browse_public_channels(role):
        can_see |= Q(channel__kind=ChannelKind.PUBLIC)
    message = Message.objects.filter(
        can_see, pk=OuterRef("entity_identifier"), removed_at__isnull=True, channel__deleted_at__isnull=True
    )
    return Q(Exists(message), entity_name=CHAT_MESSAGE_ENTITY)
