# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every chat write publishes the right event to Redis once it commits, and a request that changes nothing or
fails publishes nothing. The events' own format and timing are covered in `unit/chat/test_events.py`."""

import json
import time
from unittest import mock

import pytest
from django.db import IntegrityError
from django.utils import timezone
from redis.exceptions import ConnectionError as RedisConnectionError

from plane.chat.models import Channel, ChannelKind, ChannelMember, Message
from plane.chat.views.base import ChatBaseEndpoint
from plane.db.models import WorkspaceMember
from plane.settings.redis import redis_instance


@pytest.fixture
def event(workspace):
    """The event a request by `actor` should publish (without its timestamp)."""

    def make(event_type, channel_id, actor, **fields):
        return {
            "type": event_type,
            "workspace_id": str(workspace.id),
            "channel_id": str(channel_id),
            "actor_id": str(actor.user.id),
            **{key: str(value) for key, value in fields.items()},
        }

    return make


@pytest.fixture
def channel(make_channel, member):
    """A public channel `member` is an admin of."""
    return make_channel(admins=[member.user])


@pytest.fixture
def message(channel, member, send):
    return send(channel, member.user, "hello")


@pytest.mark.contract
@pytest.mark.django_db
class TestChannelEvents:
    def test_create(self, published, event, member, workspace, url):
        with published.after_commit():
            res = member.client.post(url("channels/"), {"name": "dev", "kind": "private"}, format="json")
        assert res.status_code == 201
        # The creator's membership comes first, so the gateway knows the channel is theirs.
        assert published.events == [
            event("member.added", res.data["id"], member, user_id=member.user.id),
            event("channel.created", res.data["id"], member),
        ]
        assert published.pubsub_channels == [f"chat:workspace:{workspace.id}"] * 2

    def test_rename(self, published, event, member, channel, url):
        with published.after_commit():
            res = member.client.patch(url(f"channels/{channel.id}/"), {"name": "renamed"}, format="json")
        assert res.status_code == 200
        assert published.events == [event("channel.updated", channel.id, member)]

    def test_a_workspace_admin_renaming_is_the_actor(self, published, event, admin, channel, url):
        with published.after_commit():
            admin.client.patch(url(f"channels/{channel.id}/"), {"description": "d"}, format="json")
        assert published.events == [event("channel.updated", channel.id, admin)]

    def test_archive_and_unarchive(self, published, event, member, channel, url):
        archive = url(f"channels/{channel.id}/archive/")
        with published.after_commit():
            assert member.client.post(archive).status_code == 200
        assert published.events == [event("channel.archived", channel.id, member)]
        published.clear()
        with published.after_commit():
            assert member.client.delete(archive).status_code == 200
        assert published.events == [event("channel.unarchived", channel.id, member)]

    def test_unarchiving_a_live_channel_is_silent(self, published, member, channel, url):
        with published.after_commit():
            assert member.client.delete(url(f"channels/{channel.id}/archive/")).status_code == 200
        assert published.events == []

    def test_archiving_twice_is_silent(self, published, member, channel, url):
        archive = url(f"channels/{channel.id}/archive/")
        member.client.post(archive)
        published.clear()
        with published.after_commit():
            assert member.client.post(archive).status_code == 200
        assert published.events == []

    def test_opening_a_new_dm_adds_both_people_then_announces_it(self, published, event, member, member2, url):
        with published.after_commit():
            res = member.client.post(url("dms/"), {"member_ids": [str(member2.user.id)]}, format="json")
        assert res.status_code == 201
        people = sorted([member.user.id, member2.user.id], key=str)
        assert published.events == [
            *(event("member.added", res.data["id"], member, user_id=user_id) for user_id in people),
            event("channel.created", res.data["id"], member),
        ]

    def test_opening_a_dm_that_exists_is_silent(self, published, member, member2, url):
        payload = {"member_ids": [str(member2.user.id)]}
        member.client.post(url("dms/"), payload, format="json")
        with published.after_commit():
            res = member2.client.post(url("dms/"), {"member_ids": [str(member.user.id)]}, format="json")
        assert res.status_code == 200
        assert published.events == []

    def test_a_group_dm_adds_everyone(self, published, event, make_actor, member, member2, url):
        third = make_actor()
        others = [str(member2.user.id), str(third.user.id)]
        with published.after_commit():
            res = member.client.post(url("dms/"), {"member_ids": others}, format="json")
        assert res.status_code == 201
        everyone = sorted([member.user.id, member2.user.id, third.user.id], key=str)
        assert published.events == [
            *(event("member.added", res.data["id"], member, user_id=user_id) for user_id in everyone),
            event("channel.created", res.data["id"], member),
        ]


@pytest.mark.contract
@pytest.mark.django_db
class TestMembershipEvents:
    def test_join(self, published, event, member2, channel, url):
        with published.after_commit():
            res = member2.client.post(url(f"channels/{channel.id}/join/"))
        assert res.status_code == 201
        assert published.events == [event("member.added", channel.id, member2, user_id=member2.user.id)]

    def test_joining_again_is_silent(self, published, member2, channel, url):
        member2.client.post(url(f"channels/{channel.id}/join/"))
        published.clear()
        with published.after_commit():
            assert member2.client.post(url(f"channels/{channel.id}/join/")).status_code == 200
        assert published.events == []

    def test_leave(self, published, event, member2, make_channel, admin, url):
        channel = make_channel(admins=[admin.user], members=[member2.user])
        with published.after_commit():
            assert member2.client.post(url(f"channels/{channel.id}/leave/")).status_code == 204
        assert published.events == [event("member.removed", channel.id, member2, user_id=member2.user.id)]

    def test_leaving_twice_is_silent(self, published, member2, make_channel, admin, url):
        channel = make_channel(admins=[admin.user], members=[member2.user])
        leave = url(f"channels/{channel.id}/leave/")
        member2.client.post(leave)
        published.clear()
        with published.after_commit():
            assert member2.client.post(leave).status_code == 204
        assert published.events == []

    def test_removing_yourself_is_leaving(self, published, event, member2, make_channel, admin, url):
        channel = make_channel(admins=[admin.user], members=[member2.user])
        with published.after_commit():
            assert member2.client.delete(url(f"channels/{channel.id}/members/{member2.user.id}/")).status_code == 204
        assert published.events == [event("member.removed", channel.id, member2, user_id=member2.user.id)]

    def test_add_members(self, published, event, make_actor, member, member2, channel, url):
        third = make_actor()
        ids = [str(member2.user.id), str(third.user.id), str(member.user.id)]  # one is already in
        with published.after_commit():
            res = member.client.post(url(f"channels/{channel.id}/members/"), {"member_ids": ids}, format="json")
        assert res.status_code == 201
        added = sorted([member2.user.id, third.user.id], key=str)
        assert published.events == [event("member.added", channel.id, member, user_id=user_id) for user_id in added]

    def test_adding_people_already_in_is_silent(self, published, member, channel, url):
        with published.after_commit():
            res = member.client.post(
                url(f"channels/{channel.id}/members/"), {"member_ids": [str(member.user.id)]}, format="json"
            )
        assert res.status_code == 200
        assert published.events == []

    def test_change_a_role(self, published, event, member, member2, make_channel, url):
        channel = make_channel(admins=[member.user], members=[member2.user])
        target = url(f"channels/{channel.id}/members/{member2.user.id}/")
        with published.after_commit():
            assert member.client.patch(target, {"role": "admin"}, format="json").status_code == 200
        assert published.events == [event("member.updated", channel.id, member, user_id=member2.user.id)]
        published.clear()
        with published.after_commit():
            assert member.client.patch(target, {"role": "member"}, format="json").status_code == 200
        assert published.events == [event("member.updated", channel.id, member, user_id=member2.user.id)]

    def test_setting_the_role_a_member_already_has_is_silent(self, published, member, member2, make_channel, url):
        channel = make_channel(admins=[member.user], members=[member2.user])
        with published.after_commit():
            res = member.client.patch(
                url(f"channels/{channel.id}/members/{member2.user.id}/"), {"role": "member"}, format="json"
            )
        assert res.status_code == 200
        assert published.events == []

    def test_an_admin_removes_someone(self, published, event, member, member2, make_channel, url):
        channel = make_channel(admins=[member.user], members=[member2.user])
        with published.after_commit():
            res = member.client.delete(url(f"channels/{channel.id}/members/{member2.user.id}/"))
        assert res.status_code == 204
        assert published.events == [event("member.removed", channel.id, member, user_id=member2.user.id)]


@pytest.mark.contract
@pytest.mark.django_db
class TestMessageEvents:
    def test_send(self, published, event, member, channel, url):
        with published.after_commit():
            res = member.client.post(url(f"channels/{channel.id}/messages/"), {"body_html": "<p>hi</p>"}, format="json")
        assert res.status_code == 201
        assert published.events == [event("message.created", channel.id, member, message_id=res.data["id"])]

    def test_a_reply_carries_its_parent(self, published, event, member, channel, message, url):
        with published.after_commit():
            res = member.client.post(
                url(f"channels/{channel.id}/messages/"),
                {"body_html": "<p>re</p>", "parent_id": str(message.id)},
                format="json",
            )
        assert res.status_code == 201
        assert published.events == [
            event("message.created", channel.id, member, message_id=res.data["id"], parent_id=message.id)
        ]

    def test_edit(self, published, event, member, channel, message, url):
        with published.after_commit():
            res = member.client.patch(
                url(f"channels/{channel.id}/messages/{message.id}/"), {"body_html": "<p>edited</p>"}, format="json"
            )
        assert res.status_code == 200
        assert published.events == [event("message.updated", channel.id, member, message_id=message.id)]

    def test_editing_a_reply_carries_its_parent(self, published, event, member, channel, message, send, url):
        reply = send(channel, member.user, "re", parent=message)
        with published.after_commit():
            member.client.patch(
                url(f"channels/{channel.id}/messages/{reply.id}/"), {"body_html": "<p>x</p>"}, format="json"
            )
        assert published.events == [
            event("message.updated", channel.id, member, message_id=reply.id, parent_id=message.id)
        ]

    def test_remove(self, published, event, member, channel, message, url):
        with published.after_commit():
            assert member.client.delete(url(f"channels/{channel.id}/messages/{message.id}/")).status_code == 204
        assert published.events == [event("message.removed", channel.id, member, message_id=message.id)]

    def test_an_admin_removing_someone_elses_message_is_the_actor(
        self, published, event, admin, member2, channel, send, url
    ):
        theirs = send(channel, member2.user, "oops")
        with published.after_commit():
            assert admin.client.delete(url(f"channels/{channel.id}/messages/{theirs.id}/")).status_code == 204
        assert published.events == [event("message.removed", channel.id, admin, message_id=theirs.id)]

    def test_removing_twice_is_silent(self, published, member, channel, message, url):
        remove = url(f"channels/{channel.id}/messages/{message.id}/")
        member.client.delete(remove)
        published.clear()
        with published.after_commit():
            assert member.client.delete(remove).status_code == 204
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db
class TestReadEvents:
    def test_moving_the_cursor(self, published, event, member, channel, send, url):
        first, second = send(channel, member.user, "a"), send(channel, member.user, "b")
        read = url(f"channels/{channel.id}/read/")
        with published.after_commit():
            assert member.client.post(read, {"message_id": str(first.id)}, format="json").status_code == 200
            assert member.client.post(read, {"message_id": str(second.id)}, format="json").status_code == 200
        assert published.events == [
            event("read.updated", channel.id, member, message_id=first.id, user_id=member.user.id),
            event("read.updated", channel.id, member, message_id=second.id, user_id=member.user.id),
        ]

    def test_an_older_message_does_not_move_it_and_is_silent(self, published, member, channel, send, url):
        first, second = send(channel, member.user, "a"), send(channel, member.user, "b")
        read = url(f"channels/{channel.id}/read/")
        member.client.post(read, {"message_id": str(second.id)}, format="json")
        published.clear()
        with published.after_commit():
            assert member.client.post(read, {"message_id": str(first.id)}, format="json").status_code == 200
            assert member.client.post(read, {"message_id": str(second.id)}, format="json").status_code == 200
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db
class TestRefusedWritesPublishNothing:
    def test_forbidden_missing_conflicting_and_invalid_requests(
        self, published, guest, member, member2, outsider, make_channel, send, url
    ):
        public = make_channel()
        private = make_channel(ChannelKind.PRIVATE, members=[member2.user])
        archived = make_channel(members=[member.user])
        archived_message = send(archived, member.user)
        theirs = send(public, member2.user)
        Channel.objects.filter(pk=archived.pk).update(archived_at=timezone.now())
        body = {"body_html": "<p>x</p>"}
        calls = [
            (guest.client.post, url("channels/"), {"name": "x"}),  # guests can't create channels
            (outsider.client.post, url("channels/"), {"name": "x"}),  # not in the workspace
            (member.client.post, url("channels/"), {"name": ""}),  # invalid
            (member.client.post, url(f"channels/{public.id}/messages/"), body),  # not in the channel
            (member.client.post, url(f"channels/{private.id}/messages/"), body),  # can't see it
            (member.client.post, url(f"channels/{archived.id}/messages/"), body),  # archived
            (member.client.patch, url(f"channels/{archived.id}/messages/{archived_message.id}/"), body),
            (member.client.patch, url(f"channels/{public.id}/"), {"name": "renamed"}),  # not an admin
            (member.client.delete, url(f"channels/{public.id}/messages/{theirs.id}/"), None),  # not theirs
            (member.client.post, url(f"channels/{public.id}/members/"), {"member_ids": [str(member.user.id)]}),
            (member.client.post, url(f"channels/{public.id}/read/"), {"message_id": str(theirs.id)}),  # not in it
            (member.client.post, url("dms/"), {"member_ids": []}),
        ]
        with published.after_commit():
            statuses = [call(path, data, format="json").status_code for call, path, data in calls]
        assert all(status >= 400 for status in statuses), statuses
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db
class TestWorkspaceAccessEvents:
    def _revoked(self, workspace, user):
        return {"type": "access.revoked", "workspace_id": str(workspace.id), "user_id": str(user.id)}

    def _published(self, published):
        # Who did it comes from the request's user, which these test clients don't set up for the signal.
        return [{key: value for key, value in event.items() if key != "actor_id"} for event in published.events]

    def test_removing_a_member_from_the_workspace(self, published, admin, member, workspace):
        membership = WorkspaceMember.objects.get(workspace=workspace, member=member.user)
        with published.after_commit():
            res = admin.client.delete(f"/api/workspaces/{workspace.slug}/members/{membership.id}/")
        assert res.status_code == 204
        assert self._published(published) == [self._revoked(workspace, member.user)]

    def test_leaving_the_workspace(self, published, member, workspace):
        with published.after_commit():
            res = member.client.post(f"/api/workspaces/{workspace.slug}/members/leave/")
        assert res.status_code == 204
        assert self._published(published) == [self._revoked(workspace, member.user)]


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestCommitAndRollbackThroughTheApi:
    """These commit for real, so the events go out from the request itself."""

    def test_the_event_is_out_by_the_time_the_response_is(self, redis, event, member, channel, url):
        res = member.client.post(url(f"channels/{channel.id}/messages/"), {"body_html": "<p>hi</p>"}, format="json")
        assert res.status_code == 201
        assert redis.events == [event("message.created", channel.id, member, message_id=res.data["id"])]

    def test_a_rolled_back_write_publishes_nothing(self, redis, member, url):
        publish = ChatBaseEndpoint.publish

        def publish_then_fail(self, *args, **kwargs):
            publish(self, *args, **kwargs)  # queued, but the write is not going to commit
            raise IntegrityError("simulated")

        with mock.patch.object(ChatBaseEndpoint, "publish", publish_then_fail):
            res = member.client.post(url("channels/"), {"name": "doomed"}, format="json")
        assert res.status_code == 409
        assert not Channel.objects.filter(name="doomed").exists()
        assert not ChannelMember.objects.filter(user=member.user).exists()
        assert redis.events == []

    def test_redis_being_down_does_not_fail_the_write(self, redis, member, channel, url):
        redis.error = RedisConnectionError("Redis is down")
        with mock.patch("plane.chat.events.log_exception") as log_exception:
            res = member.client.post(
                url(f"channels/{channel.id}/messages/"), {"body_html": "<p>still sent</p>"}, format="json"
            )
        assert res.status_code == 201
        assert Message.objects.filter(pk=res.data["id"], body_stripped="still sent").exists()
        assert redis.events == []
        log_exception.assert_called_once_with(redis.error)


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestThroughRealRedis:
    """One run over the wire, with Plane's own Redis client and `REDIS_URL` (the test stack has a Redis)."""

    def test_a_listener_receives_the_event(self, member, channel, workspace, url):
        client = redis_instance()
        pubsub = client.pubsub()
        try:
            pubsub.subscribe(f"chat:workspace:{workspace.id}")
            assert pubsub.get_message(timeout=5)["type"] == "subscribe"

            res = member.client.post(
                url(f"channels/{channel.id}/messages/"), {"body_html": "<p>live</p>"}, format="json"
            )
            assert res.status_code == 201

            received = None
            deadline = time.monotonic() + 5
            while received is None and time.monotonic() < deadline:
                received = pubsub.get_message(timeout=1)
        finally:
            pubsub.close()
            client.close()
        assert received is not None, "no event arrived"
        payload = json.loads(received["data"])
        assert {key: value for key, value in payload.items() if key != "at"} == {
            "type": "message.created",
            "workspace_id": str(workspace.id),
            "channel_id": str(channel.id),
            "message_id": str(res.data["id"]),
            "actor_id": str(member.user.id),
        }
