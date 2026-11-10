# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What Nexus Messages tells the chat gateway (`apps/chat-gateway`) when something changes.

Every chat write builds its events with the helpers below and hands them to `publish_on_commit()`,
so they go out only once the write is in the database, and never if its transaction rolls back.

Each is one JSON object, published to Redis on `chat:workspace:<workspace_id>`:

    type          an `EventType`
    workspace_id  the workspace
    channel_id    the channel; absent for `access.revoked`
    message_id    `message.*`: the message. `read.updated`: the message the read cursor moved to.
                  `agent.responding`/`agent.responded`: the message that mentioned the agent (in an agent DM,
                  the person's latest message). `agent.permission_*`: the agent's draft reply, if any
    parent_id     `message.*`, when the message is a thread reply. `agent.*` in a channel: the thread the reply goes
                  in (absent in an agent DM, whose replies are top-level)
    user_id       `member.*`, `read.updated`, `access.revoked` and `agent.permission_*`: the person it is about
    agent_id      `member.*` about an agent (`ChannelAgent`) instead of a person, and `agent.*`: the agent's registry ID
    actor_id      who made the change; absent when no request did (a job, a signal outside a request)
    at            when it was made, ISO 8601 in UTC

Keys with no value are left out. The Redis channel is workspace-wide and the gateway filters per
socket, so events carry IDs only, never bodies, names or anything else a user wrote: the client
fetches what it needs over REST, where permissions are enforced.

What is published, by write. A write that changes nothing publishes nothing.

    send / edit / remove a message    message.created / message.updated / message.removed
    post work item state changes      message.created, with no actor_id (see `project_feed.py`)
    create a channel                  member.added (the creator), then channel.created
    open a new DM or group DM         member.added for each person, then channel.created
    restore a DM's lost member        member.added
    rename, edit or link a channel    channel.updated
    archive / unarchive               channel.archived / channel.unarchived
    join or add members               member.added, once per person newly in the channel
    leave or remove                   member.removed
    change a member's role            member.updated
    add / remove an agent             member.added / member.removed, with agent_id and no user_id
    disable, enable or delete an      member.removed, member.added or member.removed, with agent_id, for
      agent in the registry             each channel it is in (see `signals.py`)
    move the read cursor forward      read.updated, private to `user_id` (the gateway enforces it)
    an agent starts on a mention      agent.responding, with no actor_id (see `agent_replies.py`)
    the agent's reply or note posts,  message.created for it, then agent.responded; agent.responded alone
      or it ends without one            when nothing could be posted
    a turn in an agent DM             agent.responding; message.created for the draft reply and message.updated
                                      as it is written and once finalised (see `agent_dm.py`); agent.responded
    an agent asks for approval in     agent.permission_requested, private to `user_id` (the DM's person; the
      an agent DM                       gateway enforces it); agent.permission_resolved once it is answered or
                                        expires
    leave the workspace or            member.removed for each channel ended and member.updated for
      deactivate the account          anyone handed a private channel (see `signals.py`), then
                                      access.revoked

Redis pub/sub keeps nothing and reaches only whoever is listening at that moment, so a client that
was disconnected catches up with `messages/?after=<id>`. A failed publish is logged and dropped:
the write it describes has already committed, so it must not fail the request. Requests publish
independently, so two close together can arrive in either order: an event means "this changed, go
and look", and the gateway re-checks access on a timer.
"""

import json
from enum import StrEnum

from crum import get_current_user
from django.db import transaction
from django.utils import timezone

from plane.settings.redis import redis_instance
from plane.utils.exception_logger import log_exception

# Seconds. The request that made the write is waiting on this, and Redis is on the local network.
_PUBLISH_TIMEOUT = 1


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
    AGENT_RESPONDING = "agent.responding"
    AGENT_RESPONDED = "agent.responded"
    AGENT_PERMISSION_REQUESTED = "agent.permission_requested"
    AGENT_PERMISSION_RESOLVED = "agent.permission_resolved"


def events_channel(workspace_id):
    """The Redis pub/sub channel for one workspace's chat events."""
    return f"chat:workspace:{workspace_id}"


def _event(event_type, workspace_id, *, with_actor=True, **ids):
    ids["actor_id"] = getattr(get_current_user(), "id", None) if with_actor else None
    event = {"type": EventType(event_type).value, "workspace_id": str(workspace_id)}
    event.update((key, str(value)) for key, value in ids.items() if value is not None)
    event["at"] = timezone.now().isoformat()
    return event


def message_event(event_type, message):
    return _event(
        event_type,
        message.workspace_id,
        channel_id=message.channel_id,
        message_id=message.pk,
        parent_id=message.parent_id,
    )


def channel_event(event_type, channel):
    return _event(event_type, channel.workspace_id, channel_id=channel.pk)


def member_event(event_type, member):
    return _event(event_type, member.workspace_id, channel_id=member.channel_id, user_id=member.user_id)


def agent_member_event(event_type, channel_agent, *, by_registry=False):
    """An agent joined or left a channel. It names the agent and no person, so no one's own access changes.

    `by_registry`: an instance admin changed the agent itself, who needn't be in the workspace, so isn't named.
    """
    return _event(
        event_type,
        channel_agent.workspace_id,
        with_actor=not by_registry,
        channel_id=channel_agent.channel_id,
        agent_id=channel_agent.agent_id,
    )


def agent_reply_event(event_type, message, agent_id):
    """An agent started or stopped working on `message`, which mentioned it. Its reply goes in `parent_id`'s thread."""
    return _event(
        event_type,
        message.workspace_id,
        channel_id=message.channel_id,
        message_id=message.pk,
        parent_id=message.parent_id or message.pk,
        agent_id=agent_id,
    )


def agent_dm_event(event_type, channel, agent_id, message_id):
    """The agent started or stopped a turn in an agent DM, prompted by the person's `message_id`."""
    return _event(event_type, channel.workspace_id, channel_id=channel.pk, message_id=message_id, agent_id=agent_id)


def agent_permission_event(event_type, channel, user_id, agent_id, message_id=None):
    """The agent in an agent DM asked its person to approve a tool call, or the question is settled."""
    return _event(
        event_type,
        channel.workspace_id,
        channel_id=channel.pk,
        user_id=user_id,
        agent_id=agent_id,
        message_id=message_id,
    )


def read_event(member):
    """`member`'s read cursor has moved to `member.last_read_message_id`."""
    return _event(
        EventType.READ_UPDATED,
        member.workspace_id,
        channel_id=member.channel_id,
        message_id=member.last_read_message_id,
        user_id=member.user_id,
    )


def access_revoked_event(workspace_id, user_id):
    return _event(EventType.ACCESS_REVOKED, workspace_id, user_id=user_id)


def publish_on_commit(*events):
    """Publish `events`, in order, once the current transaction commits (at once if there is none).

    Call it inside the same `atomic` block as the write, so that a rollback discards the events with it.
    `robust` makes Django swallow a failure here, so a Redis outage can't fail a committed write. The
    callback has to stay a plain function: Django reads its `__qualname__` to report the failure.
    """
    if not events:
        return

    def publish():
        try:
            client = redis_instance()
            # `redis_instance()` sets no timeouts, so a Redis that stops answering would hang the request for good.
            client.connection_pool.connection_kwargs.update(
                socket_connect_timeout=_PUBLISH_TIMEOUT, socket_timeout=_PUBLISH_TIMEOUT
            )
            # Closing matters: `from_url` gives every client its own connection pool.
            with client:
                for event in events:
                    client.publish(events_channel(event["workspace_id"]), json.dumps(event, separators=(",", ":")))
        except Exception as error:
            # Production's LOGGING has no handler that shows Django's report of this, so an outage would be silent.
            log_exception(error)
            raise

    transaction.on_commit(publish, robust=True)
