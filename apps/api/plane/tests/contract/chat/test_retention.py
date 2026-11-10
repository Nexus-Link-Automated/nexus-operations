# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The daily retention run (`plane.chat.retention`): what goes, what stays, and what goes with it."""

from datetime import timedelta
from unittest import mock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from crum import impersonate
from django.conf import settings
from django.utils import timezone
from freezegun import freeze_time

from plane.celery import app
from plane.chat import retention
from plane.chat.models import ChannelMember, Message, MessageReference, MessageSystemEvent, PendingMentionEmail
from plane.chat.notifications import CHAT_MENTION_SENDER, CHAT_MESSAGE_ENTITY
from plane.chat.retention import RETENTION_KEY, parse_retention_days, purge_chat_data
from plane.db.models import FileAsset, Issue, Notification, Project
from plane.license.models import InstanceConfiguration

CHAT_ATTACHMENT = FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT
NOW = timezone.now().replace(microsecond=0)


@pytest.fixture
def storage():
    """The S3 client the run deletes objects with."""
    with mock.patch("plane.chat.retention.S3Storage") as storage_class:
        storage_class.return_value.aws_storage_bucket_name = "test-bucket"
        client = storage_class.return_value.s3_client
        client.delete_objects.return_value = {}
        yield client


def _deleted_keys(storage):
    return {item["Key"] for call in storage.delete_objects.call_args_list for item in call.kwargs["Delete"]["Objects"]}


@pytest.fixture
def keep_for(db):
    def keep_for(value):
        InstanceConfiguration.objects.update_or_create(key=RETENTION_KEY, defaults={"value": str(value)})

    return keep_for


@pytest.fixture
def channel(make_channel, member, member2):
    return make_channel(members=[member.user, member2.user])


def _at(obj, when):
    """Pretend `obj` was created at `when`."""
    type(obj).all_objects.filter(pk=obj.pk).update(created_at=when)
    obj.refresh_from_db()
    return obj


def _days_ago(days, **extra):
    return NOW - timedelta(days=days, **extra)


@pytest.fixture
def old(send, channel, member):
    """A message (or reply to `parent`) sent `days` ago."""

    def make(days=40, parent=None, user=None, **extra):
        return _at(send(channel, user or member.user, parent=parent), _days_ago(days, **extra))

    return make


def _run():
    with freeze_time(NOW):
        return purge_chat_data()


def _exists(message):
    return Message.all_objects.filter(pk=message.pk).exists()


def _attach(message, user, name="photo.png"):
    with impersonate(user):
        return FileAsset.objects.create(
            attributes={"name": name, "type": "image/png", "size": 10, "channel_id": str(message.channel_id)},
            asset=f"{message.workspace_id}/{uuid4().hex}",
            workspace_id=message.workspace_id,
            entity_type=CHAT_ATTACHMENT,
            entity_identifier=str(message.id),
            is_uploaded=True,
        )


def _mention(message, receiver):
    entry = Notification.objects.create(
        workspace_id=message.workspace_id,
        entity_identifier=message.id,
        entity_name=CHAT_MESSAGE_ENTITY,
        title="mentioned you",
        sender=CHAT_MENTION_SENDER,
        receiver=receiver,
        data={},
    )
    PendingMentionEmail.objects.create(notification=entry, receiver=receiver, message=message)
    return entry


@pytest.fixture
def issue(workspace):
    project = Project.objects.create(name="Ops", identifier="OPS", workspace=workspace)
    return Issue.objects.create(name="Broken", workspace=workspace, project=project)


@pytest.mark.contract
class TestTheSetting:
    def test_forever_by_default(self, old, storage):
        ancient = old(days=3650)
        _run()
        assert _exists(ancient)

    def test_zero_is_forever(self, old, keep_for, storage):
        ancient = old(days=3650)
        keep_for(0)
        _run()
        assert _exists(ancient)

    @pytest.mark.parametrize("stored", ["5", "29", "abc", "-30", "1e3", "36501"])
    def test_a_stored_value_that_isnt_valid_deletes_nothing(self, old, keep_for, storage, stored):
        ancient = old(days=3650)
        keep_for(stored)
        _run()
        assert _exists(ancient)

    def test_turned_off_again_deletes_nothing(self, old, keep_for, storage):
        ancient = old(days=3650)
        keep_for(30)
        keep_for(0)
        _run()
        assert _exists(ancient)


@pytest.mark.contract
class TestTheCutoff:
    def test_older_than_the_setting_goes_and_the_rest_stays(self, old, keep_for, storage):
        keep_for(30)
        past = old(days=30, seconds=1)
        on_the_cutoff = old(days=30)
        inside = old(days=29, hours=23)
        _run()
        assert not _exists(past)
        assert _exists(on_the_cutoff)
        assert _exists(inside)

    def test_the_setting_is_read_in_days(self, old, keep_for, storage):
        keep_for(90)
        kept, gone = old(days=89), old(days=91)
        _run()
        assert _exists(kept)
        assert not _exists(gone)

    def test_a_removed_message_goes_like_any_other(self, old, keep_for, storage):
        keep_for(30)
        tombstone = old()
        tombstone.remove()
        _run()
        assert not _exists(tombstone)

    def test_an_automatic_post_goes_with_its_references(self, channel, keep_for, storage, issue):
        keep_for(30)
        post = Message.objects.create(
            channel=channel, system_event=MessageSystemEvent.WORK_ITEM_STATE, body_html="<p>OPS-1 moved</p>"
        )
        MessageReference.objects.create(message=post, issue=issue)
        _at(post, _days_ago(31))
        _run()
        assert not _exists(post)
        assert not MessageReference.all_objects.filter(message_id=post.pk).exists()


@pytest.mark.contract
class TestBatches:
    def test_every_batch_runs_until_none_is_left(self, old, keep_for, storage, monkeypatch):
        keep_for(30)
        monkeypatch.setattr(retention, "BATCH_SIZE", 2)
        messages = [old() for _ in range(5)]
        recent = old(days=1)
        batches = mock.Mock(wraps=retention._delete_batch)
        monkeypatch.setattr(retention, "_delete_batch", batches)
        _run()
        assert not any(_exists(message) for message in messages)
        assert _exists(recent)
        # Replies: one empty look. Top-level messages: three batches of at most two, then an empty look.
        assert batches.call_count == 5

    def test_a_failing_batch_stops_its_step_and_is_retried_next_run(self, old, keep_for, storage, monkeypatch):
        keep_for(30)
        message = old()
        storage.delete_objects.side_effect = ClientError({"Error": {"Code": "500"}}, "DeleteObjects")
        _attach(message, message.sender)
        _run()
        assert _exists(message)
        storage.delete_objects.side_effect = None
        _run()
        assert not _exists(message)


@pytest.mark.contract
class TestThreads:
    def test_a_thread_past_the_cutoff_goes_whole(self, old, keep_for, storage):
        keep_for(30)
        parent = old(days=50)
        replies = [old(days=45, parent=parent), old(days=40, parent=parent)]
        _run()
        assert not _exists(parent)
        assert not any(_exists(reply) for reply in replies)

    def test_an_old_reply_goes_from_a_thread_that_carries_on(self, old, keep_for, storage):
        keep_for(30)
        parent = old(days=50)
        old_reply = old(days=45, parent=parent)
        new_reply = old(days=2, parent=parent)
        _run()
        assert not _exists(old_reply)
        assert _exists(new_reply)

    def test_an_old_first_message_with_newer_replies_is_emptied(self, old, keep_for, storage, member, member2, issue):
        keep_for(30)
        parent = old(days=50)
        MessageReference.objects.create(message=parent, issue=issue)
        file = _attach(parent, member.user)
        entry = _mention(parent, member2.user)
        new_reply = old(days=2, parent=parent)
        reply_entry = _mention(new_reply, member2.user)
        _run()

        parent.refresh_from_db()
        assert parent.removed_at == NOW
        assert (parent.body_html, parent.body_json, parent.body_stripped) == ("", {}, "")
        assert not MessageReference.all_objects.filter(message=parent).exists()
        assert not FileAsset.all_objects.filter(pk=file.pk).exists()
        assert file.asset.name in _deleted_keys(storage)
        assert not Notification.all_objects.filter(pk=entry.pk).exists()
        assert not PendingMentionEmail.objects.filter(message=parent).exists()
        # The newer reply and its own inbox entry are untouched.
        assert _exists(new_reply)
        assert Notification.objects.filter(pk=reply_entry.pk).exists()

    def test_the_emptied_message_goes_once_its_last_reply_does(self, old, keep_for, storage):
        keep_for(30)
        parent = old(days=50)
        reply = old(days=2, parent=parent)
        _run()
        assert _exists(parent)
        _at(reply, _days_ago(31))
        _run()
        assert not _exists(reply)
        assert not _exists(parent)

    def test_a_removed_first_message_with_newer_replies_stays_removed(self, old, keep_for, storage):
        keep_for(30)
        parent = old(days=50)
        parent.remove()
        removed_at = Message.objects.get(pk=parent.pk).removed_at
        old(days=2, parent=parent)
        _run()
        assert Message.objects.get(pk=parent.pk).removed_at == removed_at


@pytest.mark.contract
class TestWhatGoesWithAMessage:
    def test_references_inbox_entries_and_queued_mentions(self, old, keep_for, storage, member2, issue):
        keep_for(30)
        gone, kept = old(), old(days=1)
        for message in (gone, kept):
            MessageReference.objects.create(message=message, issue=issue)
            _mention(message, member2.user)
        _run()
        assert not MessageReference.all_objects.filter(message_id=gone.pk).exists()
        assert not Notification.all_objects.filter(entity_identifier=gone.pk).exists()
        assert not PendingMentionEmail.objects.filter(message_id=gone.pk).exists()
        assert MessageReference.objects.filter(message=kept).exists()
        assert Notification.objects.filter(entity_identifier=kept.pk).exists()
        assert PendingMentionEmail.objects.filter(message=kept).exists()

    def test_attachments_storage_objects_and_rows(self, old, keep_for, storage, member):
        keep_for(30)
        gone, kept = old(), old(days=1)
        gone_files = [_attach(gone, member.user, "a.png"), _attach(gone, member.user, "b.png")]
        kept_file = _attach(kept, member.user)
        _run()
        assert _deleted_keys(storage) == {file.asset.name for file in gone_files}
        assert storage.delete_objects.call_args.kwargs["Bucket"] == "test-bucket"
        assert not FileAsset.all_objects.filter(pk__in=[file.pk for file in gone_files]).exists()
        assert FileAsset.objects.filter(pk=kept_file.pk).exists()

    def test_nothing_goes_if_storage_refuses(self, old, keep_for, storage, member):
        keep_for(30)
        message = old()
        file = _attach(message, member.user)
        storage.delete_objects.return_value = {"Errors": [{"Key": file.asset.name, "Code": "AccessDenied"}]}
        _run()
        assert _exists(message)
        assert FileAsset.objects.filter(pk=file.pk).exists()

    def test_a_read_cursor_on_a_deleted_message_leaves_the_unread_count_right(
        self, old, keep_for, storage, channel, member, member2, url
    ):
        keep_for(30)
        read_up_to = old(user=member2.user)
        ChannelMember.objects.filter(channel=channel, user=member.user).update(last_read_message=read_up_to)
        unread_after = [old(days=20, user=member2.user), old(days=10, user=member2.user)]
        newest = unread_after[-1]
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(last_read_message=newest)

        before = member.client.get(url(f"channels/{channel.id}/")).data["unread_count"]
        _run()
        assert not _exists(read_up_to)
        mine = member.client.get(url(f"channels/{channel.id}/")).data
        assert mine["last_read_message_id"] is None
        assert mine["unread_count"] == before == 2
        # A cursor on a message that stays doesn't move.
        theirs = member2.client.get(url(f"channels/{channel.id}/")).data
        assert theirs["last_read_message_id"] == str(newest.id)
        assert theirs["unread_count"] == 0


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestNothingIsAnnounced:
    def test_no_chat_events(self, old, keep_for, storage, published):
        keep_for(30)
        parent = old(days=50)
        old(days=40, parent=parent)
        thread = old(days=50)
        old(days=2, parent=thread)
        published.clear()
        _run()
        assert not _exists(parent)
        assert published.events == []


@pytest.mark.contract
class TestFilesLeftBehind:
    """Purged whatever the setting."""

    def test_files_of_a_removed_message(self, send, channel, member, storage):
        message = send(channel, member.user)
        file = _attach(message, member.user)
        message.remove()
        _run()
        assert file.asset.name in _deleted_keys(storage)
        assert not FileAsset.all_objects.filter(pk=file.pk).exists()
        assert _exists(message)

    def test_a_discarded_upload(self, channel, member, storage):
        with impersonate(member.user):
            upload = FileAsset.objects.create(
                attributes={"name": "x.png", "type": "image/png", "size": 1, "channel_id": str(channel.id)},
                asset=f"{channel.workspace_id}/{uuid4().hex}",
                workspace_id=channel.workspace_id,
                entity_type=CHAT_ATTACHMENT,
                is_deleted=True,
            )
        _run()
        assert _deleted_keys(storage) == {upload.asset.name}
        assert not FileAsset.all_objects.filter(pk=upload.pk).exists()

    def test_files_in_a_deleted_channel(self, send, channel, member, storage):
        message = send(channel, member.user)
        file = _attach(message, member.user)
        type(channel).all_objects.filter(pk=channel.pk).update(deleted_at=NOW)
        _run()
        assert _deleted_keys(storage) == {file.asset.name}
        assert not FileAsset.all_objects.filter(pk=file.pk).exists()

    def test_uploads_never_sent(self, channel, member, storage, monkeypatch):
        monkeypatch.setenv("UNUPLOADED_ASSET_DELETE_DAYS", "7")

        def unsent(days):
            with impersonate(member.user):
                upload = FileAsset.objects.create(
                    attributes={"name": "x.png", "type": "image/png", "size": 1, "channel_id": str(channel.id)},
                    asset=f"{channel.workspace_id}/{uuid4().hex}",
                    workspace_id=channel.workspace_id,
                    entity_type=CHAT_ATTACHMENT,
                    is_uploaded=True,
                )
            return _at(upload, _days_ago(days))

        stale, fresh = unsent(8), unsent(6)
        _run()
        assert _deleted_keys(storage) == {stale.asset.name}
        assert FileAsset.objects.filter(pk=fresh.pk).exists()

    def test_files_people_can_still_reach_stay(self, send, channel, member, storage):
        message = send(channel, member.user)
        file = _attach(message, member.user)
        other = FileAsset.objects.create(
            attributes={}, asset="elsewhere/x.png", workspace_id=channel.workspace_id, entity_type="ISSUE_ATTACHMENT"
        )
        FileAsset.objects.filter(pk=other.pk).update(is_deleted=True)
        _run()
        assert not storage.delete_objects.called
        assert FileAsset.objects.filter(pk=file.pk).exists()
        assert FileAsset.all_objects.filter(pk=other.pk).exists()


@pytest.mark.unit
class TestParsing:
    @pytest.mark.parametrize("value, days", [("", 0), (None, 0), ("0", 0), (0, 0), ("30", 30), (" 365 ", 365)])
    def test_valid(self, value, days):
        assert parse_retention_days(value) == days

    @pytest.mark.parametrize("value", ["29", "1", "36501", "-30", "abc", "30.5", "1e3", "9999999"])
    def test_invalid(self, value):
        with pytest.raises(ValueError):
            parse_retention_days(value)


@pytest.mark.unit
class TestSchedule:
    def test_runs_daily(self):
        entries = [
            entry for entry in app.conf.beat_schedule.values() if entry["task"] == retention.purge_chat_data.name
        ]
        assert len(entries) == 1
        assert "plane.chat.retention" in settings.CELERY_IMPORTS
