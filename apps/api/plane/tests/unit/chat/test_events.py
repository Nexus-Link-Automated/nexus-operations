# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""How a chat event reaches Redis: only after the commit, and never at the expense of the write.

Every test commits for real (`transaction=True`) and reads what a real subscriber received.
"""

import socket
import time
from datetime import datetime, timedelta
from unittest import mock

import pytest
import redis
from crum import impersonate
from django.db import transaction

from plane.chat.events import (
    EventType,
    access_revoked_event,
    channel_event,
    events_channel,
    member_event,
    message_event,
    publish_on_commit,
    read_event,
)
from plane.chat.models import Channel, ChannelKind, ChannelMember, Message
from plane.settings.redis import redis_instance
from plane.tests.chat_events import run_together
from plane.tests.factories import WorkspaceFactory


@pytest.fixture
def channel(workspace):
    return Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="general")


@pytest.fixture
def updated(workspace, channel):
    """The event `publish_on_commit(channel_event(CHANNEL_UPDATED, channel))` should produce."""
    return {"type": "channel.updated", "workspace_id": str(workspace.id), "channel_id": str(channel.id)}


def _publish(channel):
    publish_on_commit(channel_event(EventType.CHANNEL_UPDATED, channel))


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestWhenEventsGoOut:
    def test_after_the_commit_and_not_before(self, channel, updated, published):
        with transaction.atomic():
            _publish(channel)
            assert published.events == []
        assert published.events == [updated]

    def test_only_when_the_outermost_transaction_commits(self, channel, updated, published):
        with transaction.atomic():
            with transaction.atomic():
                _publish(channel)
            assert published.events == []
        assert published.events == [updated]

    def test_a_rollback_publishes_nothing(self, channel, published):
        with pytest.raises(RuntimeError), transaction.atomic():
            _publish(channel)
            raise RuntimeError("rolled back")
        assert published.events == []

    def test_a_rolled_back_savepoint_drops_only_its_own_events(self, workspace, channel, updated, published):
        with transaction.atomic():
            with pytest.raises(RuntimeError), transaction.atomic():
                publish_on_commit(channel_event(EventType.CHANNEL_ARCHIVED, channel))
                raise RuntimeError("savepoint rolled back")
            _publish(channel)
        assert published.events == [updated]

    def test_without_a_transaction_it_goes_at_once(self, channel, updated, published):
        _publish(channel)
        assert published.events == [updated]

    def test_nothing_to_publish_opens_no_connection(self, channel):
        with mock.patch("plane.chat.events.redis_instance") as make_client, transaction.atomic():
            publish_on_commit()
        assert not make_client.called

    def test_one_write_uses_one_connection_and_keeps_its_order(self, workspace, channel, published):
        with mock.patch("plane.chat.events.redis_instance", wraps=redis_instance) as make_client:
            with transaction.atomic():
                publish_on_commit(
                    channel_event(EventType.CHANNEL_ARCHIVED, channel),
                    channel_event(EventType.CHANNEL_UNARCHIVED, channel),
                    channel_event(EventType.CHANNEL_UPDATED, channel),
                )
        assert make_client.call_count == 1
        assert [event["type"] for event in published.events] == [
            "channel.archived",
            "channel.unarchived",
            "channel.updated",
        ]

    def test_its_connection_is_released(self, channel):
        """The test keeps the client alive, so `Redis.__del__` can't do the closing that `publish` should."""
        clients = []

        def make_client():
            clients.append(redis_instance())
            return clients[-1]

        real_close = redis.Redis.close
        with mock.patch.object(redis.Redis, "close", autospec=True, side_effect=real_close) as close:
            with mock.patch("plane.chat.events.redis_instance", make_client):
                _publish(channel)
        assert [call.args[0] for call in close.call_args_list] == clients


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestWhatEventsSay:
    def test_a_message(self, workspace, channel, make_member, published):
        message = Message.objects.create(channel=channel, sender=make_member())
        publish_on_commit(message_event(EventType.MESSAGE_CREATED, message))
        assert published.events == [
            {
                "type": "message.created",
                "workspace_id": str(workspace.id),
                "channel_id": str(channel.id),
                "message_id": str(message.id),
            }
        ]

    def test_a_reply_names_its_parent(self, channel, make_member, published):
        user = make_member()
        parent = Message.objects.create(channel=channel, sender=user)
        reply = Message.objects.create(channel=channel, sender=user, parent=parent)
        publish_on_commit(message_event(EventType.MESSAGE_CREATED, reply))
        assert published.events[0]["parent_id"] == str(parent.id)

    def test_a_member(self, workspace, channel, make_member, published):
        user = make_member()
        member = ChannelMember.objects.create(channel=channel, user=user)
        publish_on_commit(member_event(EventType.MEMBER_ADDED, member))
        assert published.events == [
            {
                "type": "member.added",
                "workspace_id": str(workspace.id),
                "channel_id": str(channel.id),
                "user_id": str(user.id),
            }
        ]

    def test_a_read_cursor(self, workspace, channel, make_member, published):
        user = make_member()
        message = Message.objects.create(channel=channel, sender=user)
        member = ChannelMember.objects.create(channel=channel, user=user, last_read_message=message)
        publish_on_commit(read_event(member))
        assert published.events == [
            {
                "type": "read.updated",
                "workspace_id": str(workspace.id),
                "channel_id": str(channel.id),
                "message_id": str(message.id),
                "user_id": str(user.id),
            }
        ]

    def test_access_revoked_has_no_channel(self, workspace, make_member, published):
        user = make_member()
        publish_on_commit(access_revoked_event(workspace.id, user.id))
        assert published.events == [
            {"type": "access.revoked", "workspace_id": str(workspace.id), "user_id": str(user.id)}
        ]

    def test_it_goes_to_its_own_workspace(self, workspace, channel, published):
        elsewhere = WorkspaceFactory()
        other = Channel.objects.create(workspace=elsewhere, kind=ChannelKind.PUBLIC, name="other")
        publish_on_commit(
            channel_event(EventType.CHANNEL_UPDATED, channel),
            channel_event(EventType.CHANNEL_UPDATED, other),
        )
        assert published.pubsub_channels == [f"chat:workspace:{workspace.id}", f"chat:workspace:{elsewhere.id}"]
        assert events_channel(workspace.id) == f"chat:workspace:{workspace.id}"

    def test_it_says_when_in_utc(self, channel, published):
        _publish(channel)
        assert datetime.fromisoformat(published.raw[0]["at"]).utcoffset() == timedelta(0)

    def test_the_actor_is_whoever_is_making_the_request(self, channel, make_member, published):
        user = make_member()
        with impersonate(user):
            _publish(channel)
        assert published.events[0]["actor_id"] == str(user.id)

    def test_no_request_means_no_actor(self, channel, published):
        _publish(channel)
        assert "actor_id" not in published.events[0]

    def test_an_unknown_type_is_refused(self, channel):
        with pytest.raises(ValueError):
            channel_event("channel.exploded", channel)


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestWhenRedisIsDown:
    """`REDIS_URL` points somewhere really broken, so these exercise the real client's real failures."""

    @pytest.fixture
    def nothing_listening(self, settings):
        settings.REDIS_URL = "redis://127.0.0.1:1/"

    def test_a_committed_transaction_is_unaffected(self, channel, nothing_listening):
        with transaction.atomic():
            Channel.objects.filter(pk=channel.pk).update(description="kept")
            _publish(channel)
        assert Channel.objects.get(pk=channel.pk).description == "kept"

    def test_outside_a_transaction_nothing_is_raised(self, channel, nothing_listening):
        _publish(channel)

    def test_later_commit_callbacks_still_run(self, channel, nothing_listening):
        ran = []
        with transaction.atomic():
            _publish(channel)
            transaction.on_commit(lambda: ran.append(True))
        assert ran == [True]

    def test_the_failure_reaches_the_log_production_keeps(self, channel, nothing_listening, caplog):
        """`plane.settings.production` has no handler that shows Django's own report of a failed callback."""
        _publish(channel)
        assert any(record.name == "plane.exception" for record in caplog.records)

    def test_a_redis_that_never_answers_cannot_hold_the_request(self, channel, settings):
        """Accepts the connection and then says nothing, as a hung server or a dropped network path does."""
        with socket.socket() as silent:
            silent.bind(("127.0.0.1", 0))
            silent.listen()
            settings.REDIS_URL = f"redis://127.0.0.1:{silent.getsockname()[1]}/"
            started = time.monotonic()
            run_together(lambda: _publish(channel), timeout=15)
        assert time.monotonic() - started < 5
