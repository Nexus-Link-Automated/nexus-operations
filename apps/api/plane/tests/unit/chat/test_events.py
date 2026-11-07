# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""`publish_on_commit`: what an event looks like, when it goes out, and that a failure never escapes."""

from datetime import datetime, timedelta
from unittest import mock
from uuid import uuid4

import pytest
from django.db import transaction
from django.utils import timezone
from redis.exceptions import ConnectionError as RedisConnectionError

from plane.chat.events import EventType, events_channel, publish_on_commit


def _publish(workspace, **fields):
    publish_on_commit(EventType.CHANNEL_UPDATED, workspace_id=workspace.id, channel_id=uuid4(), **fields)


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestEventShape:
    """Transactional, so each publish is a real commit (an ordinary test's transaction never commits)."""

    def test_every_field(self, redis, workspace):
        ids = {name: uuid4() for name in ("channel_id", "message_id", "parent_id", "user_id", "actor_id")}
        publish_on_commit(EventType.MESSAGE_CREATED, workspace_id=workspace.id, **ids)
        assert redis.events == [
            {"type": "message.created", "workspace_id": str(workspace.id)} | {k: str(v) for k, v in ids.items()}
        ]

    def test_fields_without_a_value_are_left_out(self, redis, workspace):
        publish_on_commit(EventType.ACCESS_REVOKED, workspace_id=workspace.id, user_id=None)
        assert redis.events == [{"type": "access.revoked", "workspace_id": str(workspace.id)}]

    def test_goes_to_the_workspace_channel(self, redis, workspace):
        _publish(workspace)
        assert [channel for channel, _ in redis.published] == [f"chat:workspace:{workspace.id}"]
        assert events_channel(workspace.id) == f"chat:workspace:{workspace.id}"

    def test_carries_when_it_was_made(self, redis, workspace):
        before = timezone.now()
        _publish(workspace)
        at = datetime.fromisoformat(redis.published[0][1]["at"])
        assert at.utcoffset() == timedelta(0)
        assert before <= at <= timezone.now()

    def test_every_type_is_a_dotted_string(self):
        types = {event_type.value for event_type in EventType}
        assert types == {
            "message.created",
            "message.updated",
            "message.removed",
            "channel.created",
            "channel.updated",
            "channel.archived",
            "channel.unarchived",
            "member.added",
            "member.removed",
            "member.updated",
            "read.updated",
            "access.revoked",
        }

    def test_a_plain_string_type_is_accepted(self, redis, workspace):
        publish_on_commit("read.updated", workspace_id=workspace.id)
        assert redis.events[0]["type"] == "read.updated"

    def test_the_client_is_closed_after_publishing(self, redis, workspace):
        _publish(workspace)
        _publish(workspace)
        assert redis.closed == 2


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestOnlyAfterCommit:
    """These commit for real (the other tests run inside a transaction that is rolled back)."""

    def test_nothing_goes_out_until_the_commit(self, redis, workspace):
        with transaction.atomic():
            _publish(workspace)
            assert redis.events == []
        assert len(redis.events) == 1

    def test_a_rollback_publishes_nothing(self, redis, workspace):
        with pytest.raises(RuntimeError), transaction.atomic():
            _publish(workspace)
            raise RuntimeError("the write failed")
        assert redis.events == []

    def test_a_rolled_back_savepoint_drops_only_its_own_events(self, redis, workspace):
        with transaction.atomic():
            publish_on_commit(EventType.CHANNEL_CREATED, workspace_id=workspace.id)
            with pytest.raises(RuntimeError), transaction.atomic():
                publish_on_commit(EventType.CHANNEL_ARCHIVED, workspace_id=workspace.id)
                raise RuntimeError("the inner write failed")
            publish_on_commit(EventType.CHANNEL_UPDATED, workspace_id=workspace.id)
        assert [event["type"] for event in redis.events] == ["channel.created", "channel.updated"]

    def test_events_keep_the_order_they_were_queued_in(self, redis, workspace):
        types = [EventType.MEMBER_ADDED, EventType.CHANNEL_CREATED, EventType.MESSAGE_CREATED]
        with transaction.atomic():
            for event_type in types:
                publish_on_commit(event_type, workspace_id=workspace.id)
        assert [event["type"] for event in redis.events] == [str(t) for t in types]

    def test_outside_a_transaction_it_goes_out_at_once(self, redis, workspace):
        _publish(workspace)
        assert len(redis.events) == 1


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestFailuresNeverEscape:
    def test_redis_down_is_logged_and_swallowed(self, redis, workspace):
        redis.error = RedisConnectionError("Redis is down")
        with mock.patch("plane.chat.events.log_exception") as log_exception:
            with transaction.atomic():
                _publish(workspace)
        assert redis.events == []
        log_exception.assert_called_once_with(redis.error)
        assert redis.closed == 1

    def test_no_client_at_all_is_logged_and_swallowed(self, workspace):
        error = ValueError("bad REDIS_URL")
        with (
            mock.patch("plane.chat.events.redis_instance", side_effect=error),
            mock.patch("plane.chat.events.log_exception") as log_exception,
        ):
            _publish(workspace)
        log_exception.assert_called_once_with(error)

    def test_a_malformed_event_is_logged_and_swallowed(self, redis, workspace):
        with mock.patch("plane.chat.events.log_exception") as log_exception:
            with transaction.atomic():
                publish_on_commit("message.shouted", workspace_id=workspace.id)
        assert redis.events == []
        assert isinstance(log_exception.call_args.args[0], ValueError)

    def test_one_failure_does_not_stop_the_events_after_it(self, redis, workspace):
        calls = []

        def flaky(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise RedisConnectionError("blip")
            return redis

        with (
            mock.patch("plane.chat.events.redis_instance", side_effect=flaky),
            mock.patch("plane.chat.events.log_exception"),
        ):
            with transaction.atomic():
                publish_on_commit(EventType.CHANNEL_CREATED, workspace_id=workspace.id)
                publish_on_commit(EventType.CHANNEL_UPDATED, workspace_id=workspace.id)
        assert [event["type"] for event in redis.events] == ["channel.updated"]
