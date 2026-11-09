# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every chat write tells the gateway what changed: once, after it commits, and only if something did change.

Every test commits for real (`transaction=True`) and reads what a real Redis subscriber received.
"""

import contextlib
import json
import threading
from unittest import mock

import pytest
import redis
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from plane.chat import permissions, signals
from plane.chat.models import Channel, ChannelKind, ChannelMember, ChannelMemberRole, Message
from plane.chat.permissions import get_visible_channel
from plane.chat.views import membership
from plane.db.models import Profile, WorkspaceMember
from plane.tests.chat_events import overlap_at, run_together

ALLOWED_KEYS = {"type", "workspace_id", "channel_id", "message_id", "parent_id", "user_id", "actor_id", "at"}
BODY = {"body_html": "<p>hello</p>"}


@pytest.fixture
def event(workspace):
    """The event a write should publish: IDs as strings, the empty ones left out."""

    def build(type_, actor, channel=None, message=None, parent=None, user=None):
        expected = {"type": type_, "workspace_id": str(workspace.id), "actor_id": str(actor.user.id)}
        for key, value in (("channel_id", channel), ("message_id", message), ("parent_id", parent), ("user_id", user)):
            if value is not None:
                expected[key] = str(getattr(value, "pk", value))
        return expected

    return build


@pytest.fixture
def fresh():
    """A client of the actor's own for one thread: `APIClient` isn't safe to share between threads."""

    def make(actor):
        client = APIClient()
        client.force_authenticate(user=actor.user)
        return client

    return make


@pytest.fixture
def channel(make_channel, member):
    return make_channel(members=[member.user])


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestMessageEvents:
    def test_sending(self, member, channel, url, published, event):
        res = member.client.post(url(f"channels/{channel.id}/messages/"), BODY, format="json")
        assert res.status_code == 201
        assert published.events == [event("message.created", member, channel, message=res.data["id"])]

    def test_replying_names_the_parent(self, member, channel, send, url, published, event):
        parent = send(channel, member.user)
        res = member.client.post(
            url(f"channels/{channel.id}/messages/"), {**BODY, "parent_id": str(parent.id)}, format="json"
        )
        assert published.events == [event("message.created", member, channel, message=res.data["id"], parent=parent)]

    def test_editing(self, member, channel, send, url, published, event):
        message = send(channel, member.user)
        res = member.client.patch(url(f"channels/{channel.id}/messages/{message.id}/"), BODY, format="json")
        assert res.status_code == 200
        assert published.events == [event("message.updated", member, channel, message=message)]

    def test_removing_and_then_removing_again(self, member, channel, send, url, published, event):
        message = send(channel, member.user)
        path = url(f"channels/{channel.id}/messages/{message.id}/")
        assert member.client.delete(path).status_code == 204
        assert member.client.delete(path).status_code == 204
        assert published.events == [event("message.removed", member, channel, message=message)]

    def test_an_admin_removing_someone_elses_message(self, admin, member, channel, send, url, published, event):
        message = send(channel, member.user)
        assert admin.client.delete(url(f"channels/{channel.id}/messages/{message.id}/")).status_code == 204
        assert published.events == [event("message.removed", admin, channel, message=message)]

    def test_refused_writes_publish_nothing(self, member, member2, channel, send, url, published):
        mine = send(channel, member.user)
        removed = send(channel, member.user)
        removed.remove()
        messages = url(f"channels/{channel.id}/messages/")

        assert member2.client.post(messages, BODY, format="json").status_code == 403
        assert member2.client.patch(f"{messages}{mine.id}/", BODY, format="json").status_code == 403
        assert member2.client.delete(f"{messages}{mine.id}/").status_code == 403
        assert member.client.patch(f"{messages}{removed.id}/", BODY, format="json").status_code == 409
        assert member.client.post(messages, {"body_html": "<p></p>"}, format="json").status_code == 400

        assert published.events == []

    def test_an_archived_channel_takes_no_writes_and_publishes_nothing(self, member, channel, send, url, published):
        message = send(channel, member.user)
        Channel.objects.filter(pk=channel.pk).update(archived_at=timezone.now())
        messages = url(f"channels/{channel.id}/messages/")

        assert member.client.post(messages, BODY, format="json").status_code == 409
        assert member.client.patch(f"{messages}{message.id}/", BODY, format="json").status_code == 409
        assert member.client.delete(f"{messages}{message.id}/").status_code == 409

        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestChannelEvents:
    def test_creating_adds_the_creator_and_then_the_channel(self, member, url, published, event):
        res = member.client.post(url("channels/"), {"name": "dev"}, format="json")
        assert res.status_code == 201
        assert published.events == [
            event("member.added", member, res.data["id"], user=member.user),
            event("channel.created", member, res.data["id"]),
        ]

    def test_refused_creates_publish_nothing(self, member, guest, make_channel, url, published):
        make_channel(name="taken")
        assert member.client.post(url("channels/"), {"name": "taken"}, format="json").status_code == 400
        assert guest.client.post(url("channels/"), {"name": "x"}, format="json").status_code == 403
        assert published.events == []

    def test_renaming(self, member, make_channel, url, published, event):
        channel = make_channel(admins=[member.user])
        assert member.client.patch(url(f"channels/{channel.id}/"), {"name": "new"}, format="json").status_code == 200
        assert published.events == [event("channel.updated", member, channel)]

    def test_changing_the_description(self, member, make_channel, url, published, event):
        channel = make_channel(admins=[member.user])
        res = member.client.patch(url(f"channels/{channel.id}/"), {"description": "about"}, format="json")
        assert res.status_code == 200
        assert published.events == [event("channel.updated", member, channel)]

    def test_changing_only_the_case_of_the_name_is_a_change(self, member, make_channel, url, published, event):
        channel = make_channel(name="dev", admins=[member.user])
        assert member.client.patch(url(f"channels/{channel.id}/"), {"name": "DEV"}, format="json").status_code == 200
        assert published.events == [event("channel.updated", member, channel)]

    @pytest.mark.parametrize("change", [{}, {"name": "dev"}, {"name": " dev "}, {"description": "same"}])
    def test_an_edit_that_changes_nothing_publishes_nothing(self, member, make_channel, url, published, change):
        channel = make_channel(name="dev", admins=[member.user])
        Channel.objects.filter(pk=channel.pk).update(description="same")
        res = member.client.patch(url(f"channels/{channel.id}/"), change, format="json")
        assert res.status_code == 200 and res.data["name"] == "dev"
        assert published.events == []

    def test_refused_edits_publish_nothing(self, member, member2, make_channel, url, published):
        channel = make_channel(admins=[member.user], members=[member2.user])
        make_channel(name="taken")
        path = url(f"channels/{channel.id}/")
        assert member2.client.patch(path, {"name": "x"}, format="json").status_code == 403
        assert member.client.patch(path, {"name": "taken"}, format="json").status_code == 400
        Channel.objects.filter(pk=channel.pk).update(archived_at=timezone.now())
        assert member.client.patch(path, {"name": "x"}, format="json").status_code == 409
        assert published.events == []

    def test_archiving_and_then_archiving_again(self, member, make_channel, url, published, event):
        channel = make_channel(admins=[member.user])
        path = url(f"channels/{channel.id}/archive/")
        assert member.client.post(path).status_code == 200
        assert member.client.post(path).status_code == 200
        assert published.events == [event("channel.archived", member, channel)]

    def test_unarchiving_and_then_unarchiving_again(self, member, make_channel, url, published, event):
        channel = make_channel(admins=[member.user])
        Channel.objects.filter(pk=channel.pk).update(archived_at=timezone.now())
        path = url(f"channels/{channel.id}/archive/")
        assert member.client.delete(path).status_code == 200
        assert member.client.delete(path).status_code == 200
        assert published.events == [event("channel.unarchived", member, channel)]

    def test_a_refused_archive_publishes_nothing(self, member2, member, make_channel, url, published):
        channel = make_channel(admins=[member.user], members=[member2.user])
        assert member2.client.post(url(f"channels/{channel.id}/archive/")).status_code == 403
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestDirectMessageEvents:
    def _ordered(self, *actors):
        return sorted((actor.user for actor in actors), key=lambda user: str(user.id))

    def test_opening_a_new_dm_adds_each_person_and_then_the_channel(self, member, member2, url, published, event):
        res = member.client.post(url("dms/"), {"member_ids": [str(member2.user.id)]}, format="json")
        assert res.status_code == 201
        assert published.events == [
            *[event("member.added", member, res.data["id"], user=user) for user in self._ordered(member, member2)],
            event("channel.created", member, res.data["id"]),
        ]

    def test_opening_a_group_dm(self, member, member2, guest, url, published, event):
        others = [str(member2.user.id), str(guest.user.id)]
        res = member.client.post(url("dms/"), {"member_ids": others}, format="json")
        assert res.status_code == 201
        assert published.events == [
            *[
                event("member.added", member, res.data["id"], user=user)
                for user in self._ordered(member, member2, guest)
            ],
            event("channel.created", member, res.data["id"]),
        ]

    def test_opening_it_again_publishes_nothing(self, member, member2, workspace, url, published):
        Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        published.clear()
        res = member.client.post(url("dms/"), {"member_ids": [str(member2.user.id)]}, format="json")
        assert res.status_code == 200
        assert published.events == []

    def test_restoring_a_lost_member_announces_only_them(self, member, member2, workspace, url, published, event):
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        ChannelMember.objects.filter(channel=dm, user=member2.user).delete()
        published.clear()
        res = member.client.post(url("dms/"), {"member_ids": [str(member2.user.id)]}, format="json")
        assert res.status_code == 200
        assert published.events == [event("member.added", member, dm, user=member2.user)]

    def test_a_refused_open_publishes_nothing(self, member, guest, url, published):
        assert guest.client.post(url("dms/"), {"member_ids": [str(member.user.id)]}, format="json").status_code == 403
        assert member.client.post(url("dms/"), {"member_ids": [str(member.user.id)]}, format="json").status_code == 400
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestMembershipEvents:
    def test_joining_and_then_joining_again(self, member2, channel, url, published, event):
        path = url(f"channels/{channel.id}/join/")
        assert member2.client.post(path).status_code == 201
        assert member2.client.post(path).status_code == 200
        assert published.events == [event("member.added", member2, channel, user=member2.user)]

    def test_joining_an_archived_channel_publishes_nothing(self, member2, channel, url, published):
        Channel.objects.filter(pk=channel.pk).update(archived_at=timezone.now())
        assert member2.client.post(url(f"channels/{channel.id}/join/")).status_code == 409
        assert published.events == []

    def test_leaving_and_then_leaving_again(self, member, channel, url, published, event):
        path = url(f"channels/{channel.id}/leave/")
        assert member.client.post(path).status_code == 204
        assert member.client.post(path).status_code == 204
        assert published.events == [event("member.removed", member, channel, user=member.user)]

    def test_removing_yourself_is_leaving(self, member, channel, url, published, event):
        assert member.client.delete(url(f"channels/{channel.id}/members/{member.user.id}/")).status_code == 204
        assert published.events == [event("member.removed", member, channel, user=member.user)]

    def test_adding_only_announces_the_new_people(self, member, member2, guest, channel, url, published, event):
        res = member.client.post(
            url(f"channels/{channel.id}/members/"),
            {"member_ids": [str(member.user.id), str(member2.user.id), str(guest.user.id)]},
            format="json",
        )
        assert res.status_code == 201
        new = sorted((member2.user, guest.user), key=lambda user: str(user.id))
        assert published.events == [event("member.added", member, channel, user=user) for user in new]

    def test_adding_nobody_new_publishes_nothing(self, member, channel, url, published):
        res = member.client.post(
            url(f"channels/{channel.id}/members/"), {"member_ids": [str(member.user.id)]}, format="json"
        )
        assert res.status_code == 200 and res.data == []
        assert published.events == []

    def test_a_refused_add_publishes_nothing(self, member, outsider, channel, url, published):
        res = member.client.post(
            url(f"channels/{channel.id}/members/"), {"member_ids": [str(outsider.user.id)]}, format="json"
        )
        assert res.status_code == 400
        assert published.events == []

    def test_removing_someone_and_then_removing_them_again(self, member, member2, make_channel, url, published, event):
        channel = make_channel(admins=[member.user], members=[member2.user])
        path = url(f"channels/{channel.id}/members/{member2.user.id}/")
        assert member.client.delete(path).status_code == 204
        assert member.client.delete(path).status_code == 404
        assert published.events == [event("member.removed", member, channel, user=member2.user)]

    def test_changing_a_role(self, member, member2, make_channel, url, published, event):
        channel = make_channel(admins=[member.user], members=[member2.user])
        res = member.client.patch(
            url(f"channels/{channel.id}/members/{member2.user.id}/"), {"role": "admin"}, format="json"
        )
        assert res.status_code == 200 and res.data["role"] == "admin"
        assert published.events == [event("member.updated", member, channel, user=member2.user)]

    def test_setting_the_role_they_already_have_publishes_nothing(self, member, member2, make_channel, url, published):
        channel = make_channel(admins=[member.user], members=[member2.user])
        res = member.client.patch(
            url(f"channels/{channel.id}/members/{member2.user.id}/"), {"role": "member"}, format="json"
        )
        assert res.status_code == 200 and res.data["role"] == "member"
        assert published.events == []

    def test_a_private_channels_last_admin_publishes_nothing(self, member, member2, make_channel, url, published):
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user], members=[member2.user])
        base = url(f"channels/{private.id}/")

        assert member.client.post(f"{base}leave/").status_code == 409
        assert member.client.delete(f"{base}members/{member.user.id}/").status_code == 409
        assert (
            member.client.patch(f"{base}members/{member.user.id}/", {"role": "member"}, format="json").status_code
            == 409
        )

        assert published.events == []
        assert ChannelMember.objects.filter(channel=private).count() == 2

    def test_refused_changes_publish_nothing(self, member, member2, guest, make_channel, url, published):
        channel = make_channel(admins=[member.user], members=[member2.user, guest.user])
        base = url(f"channels/{channel.id}/members/")
        assert member2.client.delete(f"{base}{guest.user.id}/").status_code == 403
        assert member2.client.patch(f"{base}{guest.user.id}/", {"role": "admin"}, format="json").status_code == 403
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestReadCursorEvents:
    @pytest.fixture
    def messages(self, channel, member, member2, send):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        return [send(channel, member2.user, f"m{i}") for i in range(3)]

    def _read(self, actor, channel, message, url):
        return actor.client.post(url(f"channels/{channel.id}/read/"), {"message_id": str(message.id)}, format="json")

    def test_moving_forward(self, member, channel, messages, url, published, event):
        assert self._read(member, channel, messages[1], url).status_code == 200
        assert published.events == [event("read.updated", member, channel, message=messages[1], user=member.user)]

    def test_a_cursor_that_doesnt_move_publishes_nothing(self, member, channel, messages, url, published):
        self._read(member, channel, messages[2], url)
        published.clear()
        assert self._read(member, channel, messages[2], url).status_code == 200
        assert self._read(member, channel, messages[0], url).status_code == 200
        assert published.events == []

    def test_refused_reads_publish_nothing(self, member, guest, channel, messages, send, url, published):
        reply = send(channel, member.user, parent=messages[0])
        assert self._read(member, channel, reply, url).status_code == 400
        assert self._read(guest, channel, messages[0], url).status_code in (403, 404)
        assert published.events == []


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestWhatEventsCarry:
    def test_ids_only(self, member, member2, url, published):
        made = member.client.post(
            url("channels/"), {"name": "secret-name", "description": "secret-about"}, format="json"
        )
        channel_id = made.data["id"]
        sent = member.client.post(
            url(f"channels/{channel_id}/messages/"),
            {"body_html": "<p>secret-body</p>", "body_json": {"text": "secret-json"}},
            format="json",
        )
        member.client.patch(
            url(f"channels/{channel_id}/messages/{sent.data['id']}/"),
            {"body_html": "<p>secret-edit</p>"},
            format="json",
        )
        member.client.patch(url(f"channels/{channel_id}/"), {"name": "secret-rename"}, format="json")
        member.client.post(
            url(f"channels/{channel_id}/members/"), {"member_ids": [str(member2.user.id)]}, format="json"
        )

        raw = published.raw
        assert len(raw) == 6
        assert all(set(event) <= ALLOWED_KEYS for event in raw)
        assert "secret" not in json.dumps(raw)
        assert member.user.email not in json.dumps(raw)


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestPublishedOnlyAfterTheCommit:
    """At the moment each event goes out, a second database connection can already see the write."""

    def _spying(self, check):
        """Calls `check(event)` on another connection at the moment of each publish, and collects the answers."""
        real_publish = redis.Redis.publish
        seen = []

        def spy(client, channel, payload, **kwargs):
            seen.append(run_together(lambda: check(json.loads(payload)))[0])
            return real_publish(client, channel, payload, **kwargs)

        return mock.patch.object(redis.Redis, "publish", spy), seen

    def test_a_new_message_outside_any_transaction(self, member, channel, url):
        patch, seen = self._spying(lambda event: Message.objects.filter(pk=event["message_id"]).exists())
        with patch:
            member.client.post(url(f"channels/{channel.id}/messages/"), BODY, format="json")
        assert seen == [True]

    def test_an_edit_inside_a_transaction(self, member, channel, send, url):
        message = send(channel, member.user)
        patch, seen = self._spying(
            lambda event: Message.objects.get(pk=event["message_id"]).body_html == "<p>edited</p>"
        )
        with patch:
            member.client.patch(
                url(f"channels/{channel.id}/messages/{message.id}/"), {"body_html": "<p>edited</p>"}, format="json"
            )
        assert seen == [True]

    def test_a_new_channel_and_its_member(self, member, url):
        patch, seen = self._spying(
            lambda event: ChannelMember.objects.filter(channel_id=event["channel_id"], user_id=member.user.id).exists()
        )
        with patch:
            member.client.post(url("channels/"), {"name": "dev"}, format="json")
        assert seen == [True, True]


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestWhenRedisIsDown:
    """Nothing is listening at `REDIS_URL`, so the real client fails for real and the write still stands."""

    @pytest.fixture(autouse=True)
    def nothing_listening(self, settings):
        settings.REDIS_URL = "redis://127.0.0.1:1/"

    def test_a_message_is_still_sent(self, member, channel, url):
        res = member.client.post(url(f"channels/{channel.id}/messages/"), BODY, format="json")
        assert res.status_code == 201
        assert Message.objects.filter(pk=res.data["id"]).exists()

    def test_a_channel_is_still_created(self, member, url):
        res = member.client.post(url("channels/"), {"name": "dev"}, format="json")
        assert res.status_code == 201
        assert ChannelMember.objects.filter(channel_id=res.data["id"], user=member.user).exists()

    def test_leaving_still_works(self, member, channel, url):
        assert member.client.post(url(f"channels/{channel.id}/leave/")).status_code == 204
        assert not ChannelMember.objects.filter(channel=channel, user=member.user).exists()


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestConcurrentWrites:
    """Two requests on real threads and real connections, overlapped where a missing guard would let both through."""

    def _twice(self, request):
        return run_together(request, request)

    def test_removing_a_message_twice_at_once(self, member, channel, send, url, published, event, fresh):
        message = send(channel, member.user)
        path = url(f"channels/{channel.id}/messages/{message.id}/")
        with overlap_at((Message, "remove")):
            codes = self._twice(lambda: fresh(member).delete(path).status_code)
        assert codes == [204, 204]
        assert published.events == [event("message.removed", member, channel, message=message)]

    def test_archiving_twice_at_once(self, member, make_channel, url, published, event, fresh):
        channel = make_channel(admins=[member.user])
        path = url(f"channels/{channel.id}/archive/")
        with overlap_at((Channel, "save")):
            codes = self._twice(lambda: fresh(member).post(path).status_code)
        assert codes == [200, 200]
        assert published.events == [event("channel.archived", member, channel)]

    def test_making_the_same_rename_twice_at_once(self, member, make_channel, url, published, event, fresh):
        channel = make_channel(admins=[member.user])
        path = url(f"channels/{channel.id}/")
        with overlap_at((Channel, "save")):
            codes = self._twice(lambda: fresh(member).patch(path, {"name": "new"}, format="json").status_code)
        assert codes == [200, 200]
        assert published.events == [event("channel.updated", member, channel)]

    def test_an_archive_during_a_rename_stays_archived(self, member, make_channel, url, published, fresh):
        channel = make_channel(admins=[member.user])
        base = url(f"channels/{channel.id}/")
        with overlap_at((Channel, "save")):
            codes = run_together(
                lambda: fresh(member).patch(base, {"name": "new"}, format="json").status_code,
                lambda: fresh(member).post(f"{base}archive/").status_code,
            )
        assert 200 in codes
        channel.refresh_from_db()
        types = [item["type"] for item in published.events]
        assert channel.archived_at is not None and "channel.archived" in types

    def test_two_channels_racing_for_one_name(self, member, make_channel, url, published, event, fresh):
        first, second = (make_channel(admins=[member.user]) for _ in range(2))

        def rename(channel):
            return lambda: fresh(member).patch(url(f"channels/{channel.id}/"), {"name": "wanted"}, format="json")

        with overlap_at((Channel, "save"), wait=5):
            codes = [res.status_code for res in run_together(rename(first), rename(second))]
        assert sorted(codes) == [200, 409]
        winner = Channel.objects.get(name="wanted")
        assert published.events == [event("channel.updated", member, winner)]

    def test_two_people_creating_one_name(self, member, member2, url, published, event, fresh):
        def create(actor):
            return lambda: fresh(actor).post(url("channels/"), {"name": "wanted"}, format="json").status_code

        with overlap_at((Channel, "save"), wait=5):
            codes = run_together(create(member), create(member2))
        assert sorted(codes) == [201, 409]
        winner = Channel.objects.get(name="wanted")
        actor = member if codes[0] == 201 else member2
        assert published.events == [
            event("member.added", actor, winner, user=actor.user),
            event("channel.created", actor, winner),
        ]

    def test_two_people_opening_one_dm(self, member, member2, url, published, fresh):
        def open_with(actor, other):
            return lambda: fresh(actor).post(url("dms/"), {"member_ids": [str(other.user.id)]}, format="json")

        with overlap_at((Channel, "save"), wait=5):
            responses = run_together(open_with(member, member2), open_with(member2, member))
        assert sorted(res.status_code for res in responses) == [200, 201]
        assert responses[0].data["id"] == responses[1].data["id"]
        types = [item["type"] for item in published.events]
        assert sorted(types) == ["channel.created", "member.added", "member.added"]

    def test_joining_twice_at_once(self, member2, channel, url, published, event, fresh):
        path = url(f"channels/{channel.id}/join/")
        with overlap_at((membership, "_latest_message_id"), wait=5):
            codes = self._twice(lambda: fresh(member2).post(path).status_code)
        assert sorted(codes) == [200, 201]
        assert published.events == [event("member.added", member2, channel, user=member2.user)]

    def test_adding_one_person_twice_at_once(self, member, member2, channel, url, published, event, fresh):
        path = url(f"channels/{channel.id}/members/")
        payload = {"member_ids": [str(member2.user.id)]}
        with overlap_at((membership, "_latest_message_id"), wait=5):
            codes = self._twice(lambda: fresh(member).post(path, payload, format="json").status_code)
        assert sorted(codes) == [201, 409]
        assert published.events == [event("member.added", member, channel, user=member2.user)]

    def test_leaving_twice_at_once(self, member, channel, url, published, event, fresh):
        path = url(f"channels/{channel.id}/leave/")
        with overlap_at((ChannelMember, "delete")):
            codes = self._twice(lambda: fresh(member).post(path).status_code)
        assert codes == [204, 204]
        assert published.events == [event("member.removed", member, channel, user=member.user)]

    def test_an_admin_removing_someone_as_they_leave(self, member, member2, make_channel, url, published, event, fresh):
        channel = make_channel(admins=[member.user], members=[member2.user])
        base = url(f"channels/{channel.id}/")
        with overlap_at((ChannelMember, "delete")):
            codes = run_together(
                lambda: fresh(member).delete(f"{base}members/{member2.user.id}/").status_code,
                lambda: fresh(member2).post(f"{base}leave/").status_code,
            )
        assert sorted(codes) in ([204, 204], [204, 404])
        assert [item["type"] for item in published.events] == ["member.removed"]

    def test_setting_the_same_role_twice_at_once(self, member, member2, make_channel, url, published, event, fresh):
        channel = make_channel(admins=[member.user], members=[member2.user])
        path = url(f"channels/{channel.id}/members/{member2.user.id}/")
        with overlap_at((ChannelMember, "save")):
            codes = self._twice(lambda: fresh(member).patch(path, {"role": "admin"}, format="json").status_code)
        assert codes == [200, 200]
        assert published.events == [event("member.updated", member, channel, user=member2.user)]

    def test_marking_the_same_message_read_twice_at_once(self, member, channel, send, url, published, event, fresh):
        message = send(channel, member.user)
        path = url(f"channels/{channel.id}/read/")
        payload = {"message_id": str(message.id)}
        with overlap_at((ChannelMember, "save")):
            codes = self._twice(lambda: fresh(member).post(path, payload, format="json").status_code)
        assert codes == [200, 200]
        assert published.events == [event("read.updated", member, channel, message=message, user=member.user)]

    def test_both_admins_leaving_at_once(self, member, member2, guest, make_channel, url, published, event, fresh):
        """One of them has to stay, without the two deadlocking over each other's rows."""
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user, member2.user], members=[guest.user])

        def leave(actor):
            return lambda: fresh(actor).post(url(f"channels/{private.id}/leave/")).status_code

        with overlap_at((permissions, "lock_channel_admins"), wait=5):
            codes = run_together(leave(member), leave(member2))
        assert sorted(codes) == [204, 409]
        gone = member if codes[0] == 204 else member2
        assert published.events == [event("member.removed", gone, private, user=gone.user)]
        assert ChannelMember.objects.filter(channel=private, role=ChannelMemberRole.ADMIN).count() == 1

    @contextlib.contextmanager
    def _both_ending_one_seat(self, wait):
        """Yields a `leave_workspace(actor)`; the request is past its checks before the departure starts."""
        request_is_ending_it, signal_is_ending_it = threading.Event(), threading.Event()
        real_delete, real_end_seat = ChannelMember.delete, signals._end_seat

        def delete(seat, *args, **kwargs):
            request_is_ending_it.set()
            signal_is_ending_it.wait(timeout=wait)
            return real_delete(seat, *args, **kwargs)

        def end_seat(seat):
            signal_is_ending_it.set()
            return real_end_seat(seat)

        def leave_workspace(row):
            assert request_is_ending_it.wait(timeout=10)
            row.is_active = False
            row.save()

        with mock.patch.object(ChannelMember, "delete", delete), mock.patch.object(signals, "_end_seat", end_seat):
            yield leave_workspace

    def test_leaving_a_channel_as_you_leave_the_workspace(self, workspace, member, channel, url, published, fresh):
        path = url(f"channels/{channel.id}/leave/")
        row = WorkspaceMember.objects.get(workspace=workspace, member=member.user)
        with self._both_ending_one_seat(wait=5) as leave_workspace:
            run_together(lambda: fresh(member).post(path).status_code, lambda: leave_workspace(row))
        removals = [item for item in published.events if item["type"] == "member.removed"]
        assert len(removals) == 1 and removals[0]["channel_id"] == str(channel.id)
        assert not ChannelMember.objects.filter(channel=channel, user=member.user).exists()

    def test_leaving_your_own_private_channel_as_you_leave_the_workspace(
        self, workspace, member, make_channel, url, published, fresh
    ):
        """The handover path ends this seat. The request holds the admin rows, so the wait runs out."""
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user])
        path = url(f"channels/{private.id}/leave/")
        row = WorkspaceMember.objects.get(workspace=workspace, member=member.user)
        with self._both_ending_one_seat(wait=1) as leave_workspace:
            run_together(lambda: fresh(member).post(path).status_code, lambda: leave_workspace(row))
        removals = [item for item in published.events if item["type"] == "member.removed"]
        assert len(removals) == 1 and removals[0]["channel_id"] == str(private.id)

    def test_the_successor_leaving_during_a_handover(
        self, workspace, member, member2, guest, make_channel, url, published, fresh
    ):
        """Picked and then leaving: they get the channel first, so they are the last admin and can't walk away."""
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user], members=[member2.user, guest.user])
        path = url(f"channels/{private.id}/leave/")
        real_successor = signals._successor
        codes, threads = [], []

        def leave():
            try:
                codes.append(fresh(member2).post(path).status_code)
            finally:
                connection.close()

        def picked_and_then_leaves(leaving):
            successor = real_successor(leaving)
            thread = threading.Thread(target=leave)
            threads.append(thread)
            thread.start()
            thread.join(timeout=1)  # Long enough for a leave that nothing holds back to land first.
            return successor

        row = WorkspaceMember.objects.get(workspace=workspace, member=member.user)
        row.is_active = False
        with mock.patch.object(signals, "_successor", picked_and_then_leaves):
            row.save()
        threads[0].join(timeout=10)

        assert codes == [409]
        assert ChannelMember.objects.get(channel=private, user=member2.user).role == ChannelMemberRole.ADMIN
        assert [(item["type"], item.get("user_id")) for item in published.events] == [
            ("member.updated", str(member2.user.id)),
            ("member.removed", str(member.user.id)),
            ("access.revoked", str(member.user.id)),
        ]

    def test_the_next_in_line_takes_over_when_the_first_has_just_left(
        self, workspace, member, member2, guest, make_channel, published
    ):
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user], members=[member2.user, guest.user])
        real_lock = signals.lock_member
        gone = []

        def just_left(candidate):
            if not gone:
                gone.append(candidate)
                run_together(lambda: ChannelMember.objects.filter(pk=candidate.pk).delete())
            return real_lock(candidate)

        row = WorkspaceMember.objects.get(workspace=workspace, member=member.user)
        row.is_active = False
        with mock.patch.object(signals, "lock_member", just_left):
            row.save()

        assert ChannelMember.objects.get(channel=private, user=guest.user).role == ChannelMemberRole.ADMIN
        assert [(item["type"], item["user_id"]) for item in published.events if "channel_id" in item] == [
            ("member.updated", str(guest.user.id)),
            ("member.removed", str(member.user.id)),
        ]

    def test_someone_promoted_as_they_leave_is_kept_as_the_last_admin(
        self, member, member2, guest, make_channel, url, published, event, fresh
    ):
        """They read their plain role, then are promoted and the only other admin goes."""
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user], members=[member2.user, guest.user])
        base = url(f"channels/{private.id}/")
        real_get = get_visible_channel
        others_acted = []

        def read_and_then_the_others_act(*args, **kwargs):
            channel = real_get(*args, **kwargs)
            if not others_acted:
                others_acted.append(True)
                role = {"role": "admin"}
                run_together(lambda: fresh(member).patch(f"{base}members/{member2.user.id}/", role, format="json"))
                run_together(lambda: fresh(member).post(f"{base}leave/"))
            return channel

        with mock.patch("plane.chat.views.base.get_visible_channel", read_and_then_the_others_act):
            res = fresh(member2).post(f"{base}leave/")

        assert res.status_code == 409
        assert ChannelMember.objects.get(channel=private, user=member2.user).role == ChannelMemberRole.ADMIN
        assert published.events == [
            event("member.updated", member, private, user=member2.user),
            event("member.removed", member, private, user=member.user),
        ]

    def test_demoting_someone_who_has_just_become_the_last_admin(
        self, member, member2, guest, make_channel, url, published, event, fresh
    ):
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user], members=[member2.user, guest.user])
        base = url(f"channels/{private.id}/")
        real_target = membership.ChannelMemberDetailEndpoint._target
        others_acted = []

        def read_and_then_the_others_act(view, channel, user_id):
            target = real_target(view, channel, user_id)
            if not others_acted:
                others_acted.append(True)
                role = {"role": "admin"}
                run_together(lambda: fresh(member).patch(f"{base}members/{member2.user.id}/", role, format="json"))
                run_together(lambda: fresh(member).post(f"{base}leave/"))
            return target

        with mock.patch.object(membership.ChannelMemberDetailEndpoint, "_target", read_and_then_the_others_act):
            res = fresh(member).patch(f"{base}members/{member2.user.id}/", {"role": "member"}, format="json")

        assert res.status_code == 409
        assert ChannelMember.objects.get(channel=private, user=member2.user).role == ChannelMemberRole.ADMIN
        assert published.events == [
            event("member.updated", member, private, user=member2.user),
            event("member.removed", member, private, user=member.user),
        ]


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestDeparturesThroughPlanesOwnEndpoints:
    """The signals, driven by the real workspace and account endpoints rather than by saving a row by hand."""

    def test_leaving_the_workspace(self, workspace, member, channel, published, event):
        res = member.client.post(f"/api/workspaces/{workspace.slug}/members/leave/")
        assert res.status_code == 204
        assert published.events == [
            event("member.removed", member, channel, user=member.user),
            event("access.revoked", member, user=member.user),
        ]

    def test_being_removed_from_the_workspace(self, workspace, admin, member, channel, published, event):
        row = WorkspaceMember.objects.get(workspace=workspace, member=member.user)
        res = admin.client.delete(f"/api/workspaces/{workspace.slug}/members/{row.id}/")
        assert res.status_code == 204
        assert published.events == [
            event("member.removed", admin, channel, user=member.user),
            event("access.revoked", admin, user=member.user),
        ]

    def test_leaving_the_workspace_hands_over_a_private_channel(
        self, workspace, member, member2, make_channel, published, event
    ):
        private = make_channel(ChannelKind.PRIVATE, admins=[member.user], members=[member2.user])
        res = member.client.post(f"/api/workspaces/{workspace.slug}/members/leave/")
        assert res.status_code == 204
        assert published.events == [
            event("member.updated", member, private, user=member2.user),
            event("member.removed", member, private, user=member.user),
            event("access.revoked", member, user=member.user),
        ]

    def test_deactivating_the_account(self, member, channel, published, event):
        Profile.objects.get_or_create(user=member.user)
        with mock.patch("plane.app.views.user.base.user_deactivation_email"):
            res = member.client.delete("/api/users/me/")
        assert res.status_code == 204
        assert published.events == [
            event("member.removed", member, channel, user=member.user),
            event("access.revoked", member, user=member.user),
        ]
