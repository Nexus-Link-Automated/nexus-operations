# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What Nexus Messages tells the chat gateway (`apps/chat-gateway`) when something changes.

After a chat write commits, the view calls `publish_on_commit()`. That registers a
`transaction.on_commit` callback, so an event goes out only once the write is in the database
and never when its transaction rolls back. Called outside a transaction, it publishes at once.

Events are published to Redis on `chat:workspace:<workspace_id>` as one JSON object each:

    type          an `EventType`
    workspace_id  the workspace
    channel_id    the channel; absent for `access.revoked`
    message_id    `message.*`: the message. `read.updated`: the message the read cursor moved to
    parent_id     `message.*` only, when the message is a thread reply (so a client can tell a reply
                  from a top-level message without fetching it)
    user_id       `member.*`, `read.updated` and `access.revoked`: the person it is about
    actor_id      who made the change; absent when nobody did through a request (e.g. a job)
    at            when it was made, ISO 8601 in UTC

Keys with no value are left out. Events carry IDs only, never message bodies or names: the
gateway forwards them and the client fetches what it needs over REST, where permissions are
enforced. The gateway re-checks access itself, so an event never grants anyone anything.

`read.updated` is private to `user_id`: the gateway delivers it only to that person's own sockets.

What is published, by write:

    create a channel         member.added (the creator), then channel.created
    open a DM / group DM     member.added for each person, then channel.created; only when it is new
    rename or edit           channel.updated
    archive / unarchive      channel.archived / channel.unarchived; only when it changes
    join or add members      member.added, once per person newly in the channel
    leave or remove          member.removed (`user_id` is the one who left)
    change a member's role   member.updated; only when the role changes
    send / edit / remove     message.created / message.updated / message.removed; removing twice is silent
    mark as read             read.updated; only when the cursor moves forward
    leave the workspace      access.revoked, from the WorkspaceMember signal (see `signals.py`)

Redis pub/sub keeps nothing and delivers to whoever is listening at that moment, so a client
that was disconnected fetches what it missed with `messages/?after=<id>`. A failed publish is
logged and dropped: it never fails the request that caused it.
"""

import contextlib
import json
from enum import StrEnum

from django.db import transaction
from django.utils import timezone

from plane.settings.redis import redis_instance
from plane.utils.exception_logger import log_exception


class EventType(StrEnum):
    MESSAGE_CREATED = "message.created"
    MESSAGE_UPDATED = "message.updated"
    MESSAGE_REMOVED = "message.removed"
    CHANNEL_CREATED = "channel.created"
    CHANNEL_UPDATED = "channel.updated"
    CHANNEL_ARCHIVED = "channel.archived"
    CHANNEL_UNARCHIVED = "channel.unarchived"
    MEMBER_ADDED = "member.added"
    MEMBER_REMOVED = "member.removed"
    MEMBER_UPDATED = "member.updated"
    READ_UPDATED = "read.updated"
    ACCESS_REVOKED = "access.revoked"


def events_channel(workspace_id):
    """The Redis pub/sub channel for one workspace's chat events."""
    return f"chat:workspace:{workspace_id}"


def publish_on_commit(
    event_type,
    *,
    workspace_id,
    channel_id=None,
    message_id=None,
    parent_id=None,
    user_id=None,
    actor_id=None,
):
    """Publish an event once the current transaction commits (at once when there is none).

    Never raises: a problem building or publishing an event is logged, and the write goes on.
    """
    try:
        event = {"type": EventType(event_type).value, "workspace_id": str(workspace_id)}
        for key, value in (
            ("channel_id", channel_id),
            ("message_id", message_id),
            ("parent_id", parent_id),
            ("user_id", user_id),
            ("actor_id", actor_id),
        ):
            if value is not None:
                event[key] = str(value)
        event["at"] = timezone.now().isoformat()
        payload = json.dumps(event, separators=(",", ":"))
        transaction.on_commit(lambda: _publish(event["workspace_id"], payload))
    except Exception as error:
        log_exception(error)


def _publish(workspace_id, payload):
    client = None
    try:
        client = redis_instance()
        client.publish(events_channel(workspace_id), payload)
    except Exception as error:
        log_exception(error)
    finally:
        if client is not None:
            # The client owns a connection pool of its own (`from_url`); release it.
            with contextlib.suppress(Exception):
                client.close()
