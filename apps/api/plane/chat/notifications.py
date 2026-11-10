# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""@mentions in messages become entries in Plane's inbox.

Mentions are found the way work item comments find theirs. Someone is notified only
if they could open the message: a mention can't tell anyone a private channel or a DM
exists. A channel set to "Nothing" gets no entry.

The entry is a snapshot, so what the inbox lists is checked when it is read: an entry
disappears once its message is removed or its receiver can no longer see the channel.

Each entry is also queued for the email digest of mentions left unread (`plane.chat.digest`).

An agent's finished reply in an agent DM reaches its person's inbox the same way, though nobody mentioned them
(`notify_agent_reply`).
"""

import uuid

from django.db import transaction
from django.db.models import Exists, OuterRef, Q

from plane.bgtasks.notification_task import get_new_comment_mentions
from plane.chat.agents import REMOVED_AGENT_NAME, agents_by_slug
from plane.chat.models import ChannelKind, ChannelMember, ChannelNotificationLevel, Message, PendingMentionEmail
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


def _sender_agent(message):
    """The agent that sent `message` as the registry has it (name None once it's gone), or None for anyone else."""
    if not message.sender_agent:
        return None
    agent = agents_by_slug([message.sender_agent]).get(message.sender_agent)
    return {
        "slug": message.sender_agent,
        "name": agent.name if agent is not None else None,
        "adapter": agent.adapter if agent is not None else None,
    }


def _data(message):
    channel = message.channel
    return {
        "chat_message": {
            "id": str(message.id),
            "channel_id": str(channel.id),
            "channel_name": channel.name,
            "channel_kind": channel.kind,
            "parent_id": str(message.parent_id) if message.parent_id else None,
            "preview": message.body_stripped.strip()[:PREVIEW_LENGTH],
            # The inbox names a person from `triggered_by`; an agent has no user, so it is named here.
            "sender_agent": _sender_agent(message),
        }
    }


def message_url(base_url, workspace_slug, message):
    """The link that opens `message` in the app: in its channel, or for a reply in its thread, highlighted."""
    url = f"{base_url.rstrip('/')}/{workspace_slug}/messages/{message.channel_id}"
    if message.parent_id:
        return f"{url}?message={message.parent_id}&reply={message.id}"
    return f"{url}?message={message.id}"


def _notify(message, previous_html):
    mentioned = _user_ids(get_new_comment_mentions(message.body_html, previous_html))
    if not mentioned:
        return
    already_notified = set(_entries(message).filter(receiver_id__in=mentioned).values_list("receiver_id", flat=True))
    data = _data(message)
    sender_agent = data["chat_message"]["sender_agent"]
    if message.sender:
        actor_name = message.sender.display_name
    else:
        actor_name = sender_agent and (sender_agent["name"] or REMOVED_AGENT_NAME)
    title = f"{actor_name} mentioned you in a message"
    entries = Notification.objects.bulk_create(
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
    PendingMentionEmail.objects.bulk_create(
        [
            PendingMentionEmail(notification_id=entry.id, receiver_id=entry.receiver_id, message_id=message.id)
            for entry in entries
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


def notify_agent_reply(message, receiver_id):
    """An agent's finished reply in an agent DM reaches its person's inbox once.

    Like a mention, so muting the DM ("Nothing") or losing access keeps it out; but not the email digest, which is
    about mentions, and whose person asked for the reply moments ago. Never raises.
    """
    try:
        with transaction.atomic():
            receivers = _recipients(message, _user_ids([receiver_id]))
            if not receivers or _entries(message).filter(receiver_id__in=receivers).exists():
                return
            data = _data(message)
            agent = data["chat_message"]["sender_agent"]
            name = (agent and agent["name"]) or REMOVED_AGENT_NAME
            Notification.objects.bulk_create(
                [
                    Notification(
                        workspace_id=message.workspace_id,
                        entity_identifier=message.id,
                        entity_name=CHAT_MESSAGE_ENTITY,
                        title=f"{name} replied to you",
                        sender=CHAT_MENTION_SENDER,
                        triggered_by_id=None,
                        receiver_id=receiver,
                        data=data,
                    )
                    for receiver in receivers
                ]
            )
    except Exception as error:
        log_exception(error)


def refresh_mention_previews(message):
    """Keep inbox entries in step with an edit or a removal, so text its author took back doesn't linger there.

    New text only reaches people who can still open the message; a removal blanks every entry. An edit that takes a
    mention out also takes back the email it would have sent.
    """
    try:
        with transaction.atomic():
            entries = _entries(message)
            if message.removed_at is None:
                still_mentioned = _user_ids(get_new_comment_mentions(message.body_html, None))
                PendingMentionEmail.objects.filter(message=message).exclude(receiver_id__in=still_mentioned).delete()
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
