# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""An @mention in a message becomes an entry in Plane's inbox, for people who can open it."""

from unittest import mock
from uuid import uuid4

import pytest
from django.db import connection
from django.urls import reverse

from plane.chat.models import ChannelKind, ChannelMember, ChannelNotificationLevel, Message
from plane.chat.notifications import CHAT_MENTION_SENDER
from plane.db.models import Notification, WorkspaceMember


def mention(user_id):
    return f'<mention-component entity_name="user_mention" entity_identifier="{user_id}"></mention-component>'


def body(*mentions, text="look at this"):
    return {"body_html": "<p>" + text + " " + "".join(mentions) + "</p>"}


def entries(user):
    return Notification.objects.filter(receiver=user, entity_name="chat_message")


@pytest.fixture
def post(url):
    def post(actor, channel, *mentions, text="look at this"):
        response = actor.client.post(url(f"channels/{channel.id}/messages/"), body(*mentions, text=text), format="json")
        assert response.status_code == 201, response.content
        return response.data

    return post


@pytest.fixture
def inbox(workspace):
    def inbox(actor, **params):
        path = reverse("notifications", kwargs={"slug": workspace.slug})
        response = actor.client.get(path, {"mentioned": "true", **params})
        assert response.status_code == 200, response.content
        return response.data

    return inbox


@pytest.fixture
def unread_mentions(workspace):
    def unread(actor):
        path = reverse("unread-notifications", kwargs={"slug": workspace.slug})
        return actor.client.get(path).data["mention_unread_notifications_count"]

    return unread


@pytest.mark.contract
class TestWhoIsNotified:
    def test_channel_member_gets_an_inbox_entry_that_links_back(
        self, member, member2, make_channel, post, inbox, unread_mentions
    ):
        channel = make_channel(name="development", members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id), text="please review")

        [row] = inbox(member2)
        assert row["entity_name"] == "chat_message"
        assert str(row["entity_identifier"]) == str(message["id"])
        assert row["sender"] == CHAT_MENTION_SENDER
        assert row["triggered_by"] == member.user.id
        assert row["project"] is None
        assert row["data"]["chat_message"] == {
            "id": str(message["id"]),
            "channel_id": str(channel.id),
            "channel_name": "development",
            "channel_kind": "public",
            "parent_id": None,
            "preview": "please review",
            "sender_agent": None,
        }
        assert row["is_mentioned_notification"] is True
        assert unread_mentions(member2) == 1

    def test_sender_is_not_notified_about_themselves(self, member, make_channel, post):
        post(member, make_channel(members=[member.user]), mention(member.user.id))
        assert not entries(member.user).exists()

    def test_a_workspace_member_outside_a_public_channel_is_notified(self, member, member2, make_channel, post, inbox):
        channel = make_channel(members=[member.user])
        post(member, channel, mention(member2.user.id))
        assert len(inbox(member2)) == 1

    def test_someone_outside_a_private_channel_learns_nothing(self, member, member2, make_channel, post):
        channel = make_channel(kind=ChannelKind.PRIVATE, members=[member.user])
        post(member, channel, mention(member2.user.id))
        assert not entries(member2.user).exists()

    def test_a_guest_outside_a_public_channel_learns_nothing(self, member, guest, make_channel, post):
        post(member, make_channel(members=[member.user]), mention(guest.user.id))
        assert not entries(guest.user).exists()

    def test_a_guest_in_the_channel_is_notified(self, member, guest, make_channel, post):
        post(member, make_channel(members=[member.user, guest.user]), mention(guest.user.id))
        assert entries(guest.user).count() == 1

    def test_someone_in_another_workspace_learns_nothing(self, member, outsider, make_channel, post):
        post(member, make_channel(members=[member.user]), mention(outsider.user.id))
        assert not entries(outsider.user).exists()

    def test_a_deactivated_member_is_skipped(self, workspace, member, member2, make_channel, post):
        channel = make_channel(members=[member.user, member2.user])
        WorkspaceMember.objects.filter(workspace=workspace, member=member2.user).update(is_active=False)
        post(member, channel, mention(member2.user.id))
        assert not entries(member2.user).exists()

    @pytest.mark.parametrize(
        ("level", "expected"),
        [
            (ChannelNotificationLevel.ALL, 1),
            (ChannelNotificationLevel.MENTIONS, 1),
            (ChannelNotificationLevel.NONE, 0),
        ],
    )
    def test_the_channels_notification_setting(self, member, member2, make_channel, post, level, expected):
        channel = make_channel(members=[member.user, member2.user])
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(notification_level=level)
        post(member, channel, mention(member2.user.id))
        assert entries(member2.user).count() == expected

    def test_two_mentions_of_one_person_make_one_entry(self, member, member2, make_channel, post):
        channel = make_channel(members=[member.user, member2.user])
        post(member, channel, mention(member2.user.id), mention(member2.user.id))
        assert entries(member2.user).count() == 1

    def test_a_forged_or_unknown_id_doesnt_stop_the_message(self, member, make_channel, post):
        channel = make_channel(members=[member.user])
        post(member, channel, mention("not-a-uuid"), mention(uuid4()))
        assert not Notification.objects.filter(entity_name="chat_message").exists()

    def test_a_failure_while_notifying_still_sends_the_message(self, member, member2, make_channel, post):
        channel = make_channel(members=[member.user, member2.user])
        with mock.patch("plane.chat.notifications._notify", side_effect=RuntimeError("boom")):
            message = post(member, channel, mention(member2.user.id))
        assert message["id"]

    def test_a_reply_points_at_its_thread(self, member, member2, make_channel, send, url):
        channel = make_channel(members=[member.user, member2.user])
        parent = send(channel, member.user, "start")
        response = member.client.post(
            url(f"channels/{channel.id}/messages/"),
            {**body(mention(member2.user.id)), "parent_id": str(parent.id)},
            format="json",
        )
        assert response.status_code == 201, response.content
        assert entries(member2.user).get().data["chat_message"]["parent_id"] == str(parent.id)


@pytest.mark.contract
class TestEditing:
    def edit(self, actor, channel, message, url, *mentions, text="edited"):
        response = actor.client.patch(
            url(f"channels/{channel.id}/messages/{message['id']}/"), body(*mentions, text=text), format="json"
        )
        assert response.status_code == 200, response.content

    def test_only_people_newly_mentioned_are_notified(self, member, member2, admin, make_channel, post, url):
        channel = make_channel(members=[member.user, member2.user, admin.user])
        message = post(member, channel, mention(member2.user.id))
        self.edit(member, channel, message, url, mention(member2.user.id), mention(admin.user.id))
        assert entries(member2.user).count() == 1
        assert entries(admin.user).count() == 1

    def test_mentioned_removed_and_mentioned_again_stays_one_entry(self, member, member2, make_channel, post, url):
        channel = make_channel(members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id))
        self.edit(member, channel, message, url)
        self.edit(member, channel, message, url, mention(member2.user.id))
        assert entries(member2.user).count() == 1

    def test_an_edit_updates_the_preview(self, member, member2, make_channel, post, url, inbox):
        channel = make_channel(members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id), text="secret token abc")
        self.edit(member, channel, message, url, mention(member2.user.id), text="never mind")
        assert inbox(member2)[0]["data"]["chat_message"]["preview"] == "never mind"

    def test_an_edit_doesnt_reach_someone_who_lost_the_channel(self, member, member2, make_channel, post, url):
        channel = make_channel(kind=ChannelKind.PRIVATE, members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id), text="before")
        ChannelMember.objects.filter(channel=channel, user=member2.user).delete()
        self.edit(member, channel, message, url, text="after they left")
        assert entries(member2.user).get().data["chat_message"]["preview"] == "before"

    def test_a_failed_query_while_notifying_keeps_the_edit(self, member, member2, make_channel, post, url):
        channel = make_channel(members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id))

        def broken(*_args):
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1/0")

        with mock.patch("plane.chat.notifications._notify", broken):
            self.edit(member, channel, message, url, text="kept")
        assert Message.objects.get(pk=message["id"]).body_stripped.strip() == "kept"


@pytest.mark.contract
class TestWhatTheInboxShows:
    def test_a_removed_message_leaves_the_inbox_and_its_text_is_gone(
        self, member, member2, make_channel, post, url, inbox, unread_mentions
    ):
        channel = make_channel(members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id), text="oops")
        assert member.client.delete(url(f"channels/{channel.id}/messages/{message['id']}/")).status_code == 204
        assert inbox(member2) == []
        assert unread_mentions(member2) == 0
        assert entries(member2.user).get().data["chat_message"]["preview"] == ""

    def test_a_failed_query_while_refreshing_keeps_the_removal(self, member, member2, make_channel, post, url):
        channel = make_channel(members=[member.user, member2.user])
        message = post(member, channel, mention(member2.user.id))

        def broken(*_args):
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1/0")

        with mock.patch("plane.chat.notifications._data", broken):
            response = member.client.delete(url(f"channels/{channel.id}/messages/{message['id']}/"))
        assert response.status_code == 204, response.content
        assert Message.objects.get(pk=message["id"]).removed_at is not None

    def test_a_preview_is_plain_text(self, member, member2, make_channel, post, inbox):
        channel = make_channel(members=[member.user, member2.user])
        post(member, channel, mention(member2.user.id), text="Q&amp;A")
        assert inbox(member2)[0]["data"]["chat_message"]["preview"] == "Q&A"

    def test_losing_access_to_the_channel_hides_the_entry(
        self, member, member2, make_channel, post, inbox, unread_mentions
    ):
        channel = make_channel(kind=ChannelKind.PRIVATE, members=[member.user, member2.user])
        post(member, channel, mention(member2.user.id))
        assert len(inbox(member2)) == 1
        ChannelMember.objects.filter(channel=channel, user=member2.user).delete()
        assert inbox(member2) == []
        assert unread_mentions(member2) == 0

    def test_work_item_notifications_are_still_listed(self, workspace, member, inbox):
        Notification.objects.create(
            workspace=workspace,
            entity_name="issue",
            entity_identifier=uuid4(),
            title="assigned",
            sender="in_app:issue_activities:mentioned",
            receiver=member.user,
        )
        assert [row["entity_name"] for row in inbox(member)] == ["issue"]

    def test_other_kinds_of_entry_stay_out(self, workspace, member, inbox):
        Notification.objects.create(
            workspace=workspace,
            entity_name="something_else",
            entity_identifier=uuid4(),
            title="x",
            sender="in_app:other:mentioned",
            receiver=member.user,
        )
        assert inbox(member) == []
