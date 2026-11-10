# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Filenames, removal and clean-up of message attachments."""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.bgtasks.file_asset_task import delete_unuploaded_file_asset
from plane.chat.attachments import clean_filename
from plane.chat.models import Channel, ChannelKind, Message
from plane.db.models import FileAsset

CHAT_ATTACHMENT = FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT


@pytest.fixture
def channel(workspace):
    return Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="general")


@pytest.fixture
def alice(make_member):
    return make_member()


def _asset(channel, user, age_days=0, on=None, is_uploaded=True, entity_type=CHAT_ATTACHMENT):
    asset = FileAsset.objects.create(
        attributes={"name": "a.png", "type": "image/png", "size": 10, "channel_id": str(channel.id)},
        asset=f"{channel.workspace_id}/{uuid4().hex}",
        workspace_id=channel.workspace_id,
        created_by=user,
        entity_type=entity_type,
        entity_identifier=str(on.id) if on else None,
        is_uploaded=is_uploaded,
    )
    if age_days:
        FileAsset.objects.filter(pk=asset.pk).update(created_at=timezone.now() - timedelta(days=age_days))
    return asset


def _alive(asset):
    return FileAsset.objects.filter(pk=asset.pk).exists()


@pytest.mark.unit
class TestCleanFilename:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("photo.png", "photo.png"),
            ("../etc/passwd", "passwd"),
            ("..\\..\\win.ini", "win.ini"),
            ("evil‮gnp.exe", "evilgnp.exe"),
            ("zero​width.txt", "zerowidth.txt"),
            ("  spaced .txt ", "spaced .txt"),
            ("...", "unnamed"),
            ("‮", "unnamed"),
        ],
    )
    def test_cleaning(self, raw, expected):
        assert clean_filename(raw) == expected

    def test_long_names_keep_their_extension(self):
        cleaned = clean_filename(f"{'x' * 800}.tar.gz")
        assert len(cleaned) == 255 and cleaned.endswith(".gz")

    def test_an_extension_too_long_to_keep(self):
        assert len(clean_filename(f"a.{'b' * 800}")) == 255


@pytest.mark.unit
@pytest.mark.django_db
class TestRemove:
    def test_remove_soft_deletes_the_attachments(self, channel, alice):
        message = Message.objects.create(channel=channel, sender=alice, body_html="<p>x</p>")
        attached = _asset(channel, alice, on=message)
        message.remove()
        attached = FileAsset.all_objects.get(pk=attached.pk)
        assert attached.is_deleted and attached.deleted_at is not None

    def test_other_messages_files_are_left(self, channel, alice):
        message = Message.objects.create(channel=channel, sender=alice, body_html="<p>x</p>")
        other = Message.objects.create(channel=channel, sender=alice, body_html="<p>y</p>")
        theirs = _asset(channel, alice, on=other)
        message.remove()
        assert _alive(theirs)

    def test_an_entity_id_collision_on_another_type_is_left(self, channel, alice):
        message = Message.objects.create(channel=channel, sender=alice, body_html="<p>x</p>")
        other_kind = _asset(channel, alice, on=message, entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT)
        message.remove()
        assert _alive(other_kind)


@pytest.mark.unit
@pytest.mark.django_db
class TestCleanup:
    def test_a_file_uploaded_but_never_sent_is_deleted(self, channel, alice):
        abandoned = _asset(channel, alice, age_days=8)
        delete_unuploaded_file_asset()
        assert not _alive(abandoned)

    def test_an_upload_never_finished_is_deleted(self, channel, alice):
        abandoned = _asset(channel, alice, age_days=8, is_uploaded=False)
        delete_unuploaded_file_asset()
        assert not _alive(abandoned)

    def test_a_file_on_a_message_is_kept(self, channel, alice):
        message = Message.objects.create(channel=channel, sender=alice, body_html="<p>x</p>")
        sent = _asset(channel, alice, age_days=8, on=message)
        delete_unuploaded_file_asset()
        assert _alive(sent)

    def test_recent_uploads_are_kept(self, channel, alice):
        recent = _asset(channel, alice, age_days=1)
        delete_unuploaded_file_asset()
        assert _alive(recent)

    def test_finished_uploads_of_other_types_are_kept(self, channel, alice):
        other = _asset(channel, alice, age_days=30, entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT)
        delete_unuploaded_file_asset()
        assert _alive(other)
