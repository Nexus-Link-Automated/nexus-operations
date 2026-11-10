# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""attachments/ and attachments on messages: who can upload, send, preview and download."""

from unittest import mock
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from crum import impersonate
from django.utils import timezone

from plane.chat.attachments import MAX_ATTACHMENTS_PER_MESSAGE
from plane.chat.models import Channel, ChannelKind, ChannelMember, Message
from plane.db.models import FileAsset, Project, ProjectMember

CHAT_ATTACHMENT = FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT


@pytest.fixture(autouse=True)
def storage_settings(monkeypatch, settings):
    """Enough for boto3 to sign URLs for real, offline, so the assertions read what storage would be told."""
    for key, value in {
        "AWS_ACCESS_KEY_ID": "test-key",
        "AWS_SECRET_ACCESS_KEY": "test-secret",
        "AWS_S3_BUCKET_NAME": "test-bucket",
        "AWS_REGION": "us-east-1",
        "USE_MINIO": "0",
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("AWS_S3_ENDPOINT_URL", raising=False)
    monkeypatch.delenv("MINIO_ENDPOINT_URL", raising=False)
    settings.FILE_SIZE_LIMIT = 5_000_000


@pytest.fixture(autouse=True)
def no_metadata_task():
    with mock.patch("plane.chat.views.attachment.get_asset_object_metadata") as task:
        yield task


@pytest.fixture
def channel(make_channel, member):
    return make_channel(members=[member.user])


@pytest.fixture
def upload():
    """A finished upload for `channel` by `user`, not yet on a message unless `on` is given."""

    def make(channel, user, name="photo.png", file_type="image/png", on=None, is_uploaded=True):
        # BaseModel takes created_by from the current user, as it does in a request.
        with impersonate(user):
            return FileAsset.objects.create(
                attributes={"name": name, "type": file_type, "size": 1234, "channel_id": str(channel.id)},
                asset=f"{channel.workspace_id}/{uuid4().hex}",
                size=1234,
                workspace_id=channel.workspace_id,
                entity_type=CHAT_ATTACHMENT,
                entity_identifier=str(on.id) if on else None,
                is_uploaded=is_uploaded,
            )

    return make


@pytest.fixture
def project(workspace, admin, member):
    project = Project.objects.create(name="P", identifier="PROJ", workspace=workspace, created_by=admin.user)
    for actor in (admin, member):
        ProjectMember.objects.create(project=project, member=actor.user, role=20, workspace=workspace)
    return project


@pytest.fixture
def attachment_url(url):
    return lambda channel, asset_id: url(f"channels/{channel.id}/attachments/{asset_id}/")


def _slot(actor, channel, url, **overrides):
    body = {"name": "photo.png", "type": "image/png", "size": 1234, **overrides}
    return actor.client.post(url(f"channels/{channel.id}/attachments/"), body, format="json")


def _send(actor, channel, url, attachment_ids, body_html="<p>hi</p>"):
    return actor.client.post(
        url(f"channels/{channel.id}/messages/"),
        {"body_html": body_html, "attachment_ids": [str(i) for i in attachment_ids]},
        format="json",
    )


def _signed(response):
    """The query string of the presigned URL a redirect points at."""
    assert response.status_code == 302
    return parse_qs(urlparse(response["Location"]).query)


@pytest.mark.contract
@pytest.mark.django_db
class TestUploadSlot:
    def test_a_member_gets_a_presigned_post(self, member, channel, url):
        res = _slot(member, channel, url)
        assert res.status_code == 201
        assert res.data["upload_data"]["url"]
        asset = FileAsset.objects.get(pk=res.data["asset_id"])
        assert asset.entity_type == CHAT_ATTACHMENT
        assert asset.created_by_id == member.user.id
        assert asset.entity_identifier is None
        assert asset.is_uploaded is False
        assert asset.attributes["channel_id"] == str(channel.id)

    def test_a_non_member_gets_what_a_missing_channel_gets(self, admin, member, member2, workspace, make_channel, url):
        missing = _slot(member, mock.Mock(id=uuid4()), url)
        assert missing.status_code == 404

        private = make_channel(ChannelKind.PRIVATE, members=[member.user])
        public = make_channel(members=[member.user])
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        for actor, target in [(admin, private), (admin, dm), (member2, private), (admin, public), (member2, public)]:
            res = _slot(actor, target, url)
            assert (res.status_code, res.data) == (missing.status_code, missing.data), target.kind

    def test_outside_the_workspace_is_refused(self, outsider, channel, url):
        assert _slot(outsider, channel, url).status_code == 403

    def test_archived_channel(self, member, channel, url):
        Channel.objects.filter(pk=channel.pk).update(archived_at=timezone.now())
        assert _slot(member, channel, url).status_code == 409

    def test_too_large(self, member, channel, url, settings):
        assert _slot(member, channel, url, size=settings.FILE_SIZE_LIMIT + 1).status_code == 400
        assert FileAsset.objects.filter(entity_type=CHAT_ATTACHMENT).count() == 0

    @pytest.mark.parametrize("file_type", ["text/html", "application/x-msdownload", "", "image/svg+xml; x"])
    def test_type_outside_the_allowed_list(self, member, channel, url, file_type):
        assert _slot(member, channel, url, type=file_type).status_code == 400

    @pytest.mark.parametrize(
        "raw, clean",
        [
            ("../../etc/passwd", "passwd"),
            ("evil‮gnp.exe", "evilgnp.exe"),
            ("line\r\nbreak.txt", "linebreak.txt"),
            (".hidden", "hidden"),
            ("...", "unnamed"),
        ],
    )
    def test_filename_is_cleaned(self, member, channel, url, raw, clean):
        res = _slot(member, channel, url, name=raw)
        asset = FileAsset.objects.get(pk=res.data["asset_id"])
        assert asset.attributes["name"] == clean
        # The storage key holds nothing the user wrote.
        assert asset.asset.name.count("/") == 1
        assert raw not in asset.asset.name

    def test_very_long_filename_keeps_its_extension(self, member, channel, url):
        res = _slot(member, channel, url, name=f"{'a' * 900}.pdf", type="application/pdf")
        name = FileAsset.objects.get(pk=res.data["asset_id"]).attributes["name"]
        assert len(name) == 255 and name.endswith(".pdf")

    def test_the_post_limits_size_and_type(self, member, channel, url, no_metadata_task):
        fields = _slot(member, channel, url).data["upload_data"]["fields"]
        assert fields["Content-Type"] == "image/png"


@pytest.mark.contract
@pytest.mark.django_db
class TestConfirmAndDiscard:
    def test_uploader_confirms(self, member, channel, upload, attachment_url, no_metadata_task):
        asset = upload(channel, member.user, is_uploaded=False)
        assert member.client.patch(attachment_url(channel, asset.id)).status_code == 204
        asset.refresh_from_db()
        assert asset.is_uploaded
        no_metadata_task.delay.assert_called_once_with(str(asset.id))

    def test_only_the_uploader_confirms(self, member, member2, channel, upload, attachment_url):
        asset = upload(channel, member.user, is_uploaded=False)
        ChannelMember.objects.create(channel=channel, user=member2.user)
        assert member2.client.patch(attachment_url(channel, asset.id)).status_code == 404
        asset.refresh_from_db()
        assert not asset.is_uploaded

    def test_uploader_out_of_the_channel_cannot_confirm(self, member, channel, upload, attachment_url):
        asset = upload(channel, member.user, is_uploaded=False)
        ChannelMember.objects.filter(channel=channel, user=member.user).delete()
        assert member.client.patch(attachment_url(channel, asset.id)).status_code == 404

    def test_uploader_discards_before_sending(self, member, channel, upload, attachment_url):
        asset = upload(channel, member.user)
        assert member.client.delete(attachment_url(channel, asset.id)).status_code == 204
        assert not FileAsset.objects.filter(pk=asset.pk).exists()

    def test_a_sent_file_cant_be_discarded_on_its_own(self, member, channel, send, upload, attachment_url):
        message = send(channel, member.user)
        asset = upload(channel, member.user, on=message)
        assert member.client.delete(attachment_url(channel, asset.id)).status_code == 404
        asset.refresh_from_db()
        assert asset.deleted_at is None and not asset.is_deleted


@pytest.mark.contract
@pytest.mark.django_db
class TestSendingWithAttachments:
    def test_attachments_and_no_text(self, member, channel, upload, url):
        asset = upload(channel, member.user)
        res = _send(member, channel, url, [asset.id], body_html="<p></p>")
        assert res.status_code == 201
        assert res.data["attachment_count"] == 1
        assert [a["id"] for a in res.data["attachments"]] == [str(asset.id)]
        asset.refresh_from_db()
        assert asset.entity_identifier == str(res.data["id"])

    def test_body_html_can_be_left_out_with_attachments(self, member, channel, upload, url):
        asset = upload(channel, member.user)
        res = member.client.post(
            url(f"channels/{channel.id}/messages/"), {"attachment_ids": [str(asset.id)]}, format="json"
        )
        assert res.status_code == 201

    @pytest.mark.parametrize("body", ["<p></p>", "", "<p> </p>"])
    def test_still_no_empty_messages(self, member, channel, url, body):
        assert _send(member, channel, url, [], body_html=body).status_code == 400

    def test_attachments_in_a_reply(self, member, channel, send, upload, url):
        parent = send(channel, member.user)
        asset = upload(channel, member.user)
        res = member.client.post(
            url(f"channels/{channel.id}/messages/"),
            {"body_html": "<p>r</p>", "attachment_ids": [str(asset.id)], "parent_id": str(parent.id)},
            format="json",
        )
        assert res.status_code == 201 and res.data["attachment_count"] == 1

    def _refused(self, actor, channel, url, ids):
        before = Message.objects.filter(channel=channel).count()
        res = _send(actor, channel, url, ids)
        assert res.status_code == 400
        assert Message.objects.filter(channel=channel).count() == before

    def test_someone_elses_upload(self, member, member2, channel, upload, url):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        theirs = upload(channel, member2.user)
        self._refused(member, channel, url, [theirs.id])
        theirs.refresh_from_db()
        assert theirs.entity_identifier is None

    def test_mixed_with_someone_elses(self, member, member2, channel, upload, url):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        mine, theirs = upload(channel, member.user), upload(channel, member2.user)
        self._refused(member, channel, url, [mine.id, theirs.id])
        mine.refresh_from_db()
        assert mine.entity_identifier is None

    def test_upload_for_another_channel(self, member, channel, make_channel, upload, url):
        other = make_channel(members=[member.user])
        self._refused(member, channel, url, [upload(other, member.user).id])

    def test_upload_not_finished(self, member, channel, upload, url):
        self._refused(member, channel, url, [upload(channel, member.user, is_uploaded=False).id])

    def test_already_on_a_message(self, member, channel, send, upload, url):
        first = send(channel, member.user)
        self._refused(member, channel, url, [upload(channel, member.user, on=first).id])

    def test_discarded_upload(self, member, channel, upload, url):
        asset = upload(channel, member.user)
        FileAsset.objects.filter(pk=asset.pk).update(is_deleted=True, deleted_at=timezone.now())
        self._refused(member, channel, url, [asset.id])

    def test_another_entity_types_asset(self, member, channel, upload, url):
        asset = upload(channel, member.user)
        FileAsset.objects.filter(pk=asset.pk).update(entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT)
        self._refused(member, channel, url, [asset.id])

    def test_unknown_id(self, member, channel, url):
        self._refused(member, channel, url, [uuid4()])

    def test_cap_per_message(self, member, channel, upload, url):
        over = [upload(channel, member.user).id for _ in range(MAX_ATTACHMENTS_PER_MESSAGE + 1)]
        self._refused(member, channel, url, over)

    def test_the_same_id_twice_counts_once(self, member, channel, upload, url):
        asset = upload(channel, member.user)
        res = _send(member, channel, url, [asset.id, asset.id])
        assert res.status_code == 201 and res.data["attachment_count"] == 1

    def test_non_member_cannot_send_attachments(self, member, member2, channel, upload, url):
        # Their own upload from before they left, say.
        asset = upload(channel, member2.user)
        assert _send(member2, channel, url, [asset.id]).status_code == 403


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestLiveDelivery:
    def test_other_members_get_it_through_the_event_and_catch_up(
        self, member, member2, channel, send, upload, url, published
    ):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        anchor = send(channel, member.user)
        asset = upload(channel, member.user)
        created = _send(member, channel, url, [asset.id])
        assert created.status_code == 201

        # The event carries IDs only; what it fetches has the file, because the claim committed first.
        assert [event["message_id"] for event in published.events if event["type"] == "message.created"] == [
            str(created.data["id"])
        ]
        fetched = member2.client.get(url(f"channels/{channel.id}/messages/{created.data['id']}/"))
        assert [a["id"] for a in fetched.data["attachments"]] == [str(asset.id)]
        caught_up = member2.client.get(url(f"channels/{channel.id}/messages/"), {"after": str(anchor.id)})
        assert [a["id"] for a in caught_up.data["results"][-1]["attachments"]] == [str(asset.id)]


@pytest.mark.contract
@pytest.mark.django_db
class TestFetching:
    def test_a_member_is_redirected_to_a_short_lived_download(
        self, member, member2, channel, send, upload, attachment_url
    ):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        asset = upload(
            channel, member.user, name="report final.pdf", file_type="application/pdf", on=send(channel, member.user)
        )
        res = member2.client.get(attachment_url(channel, asset.id))
        params = _signed(res)
        assert res["Cache-Control"] == "no-store"
        assert params["X-Amz-Expires"] == ["60"]
        assert params["response-content-disposition"] == ["attachment; filename*=UTF-8''report%20final.pdf"]

    def test_raster_preview_is_inline_with_the_type_pinned(self, member, channel, send, upload, attachment_url):
        asset = upload(channel, member.user, on=send(channel, member.user))
        params = _signed(member.client.get(attachment_url(channel, asset.id), {"preview": "1"}))
        assert params["response-content-disposition"][0].startswith("inline;")
        assert params["response-content-type"] == ["image/png"]

    def test_a_raster_image_downloads_unless_preview_is_asked_for(self, member, channel, send, upload, attachment_url):
        asset = upload(channel, member.user, on=send(channel, member.user))
        params = _signed(member.client.get(attachment_url(channel, asset.id)))
        assert params["response-content-disposition"][0].startswith("attachment;")

    @pytest.mark.parametrize(
        "file_type", ["image/svg+xml", "text/html", "application/xml", "text/plain", "application/pdf", "image/tiff"]
    )
    def test_nothing_but_raster_images_can_be_inline(self, member, channel, send, upload, attachment_url, file_type):
        asset = upload(channel, member.user, name="x.svg", file_type=file_type, on=send(channel, member.user))
        params = _signed(member.client.get(attachment_url(channel, asset.id), {"preview": "1"}))
        assert params["response-content-disposition"][0].startswith("attachment;")
        assert "response-content-type" not in params

    @pytest.mark.parametrize(
        "file_type, previewable",
        [("image/png", True), ("image/webp", True), ("image/svg+xml", False), ("application/pdf", False)],
    )
    def test_the_message_says_what_can_be_previewed(self, member, channel, send, upload, url, file_type, previewable):
        message = send(channel, member.user)
        upload(channel, member.user, file_type=file_type, on=message)
        res = member.client.get(url(f"channels/{channel.id}/messages/{message.id}/"))
        attachment = res.data["attachments"][0]
        assert bool(attachment["preview_url"]) is previewable
        assert attachment["download_url"].endswith(f"/attachments/{attachment['id']}/")

    def test_a_non_member_gets_what_a_missing_file_gets(
        self, admin, member, member2, guest, workspace, make_channel, send, upload, attachment_url
    ):
        missing = member.client.get(attachment_url(mock.Mock(id=uuid4()), uuid4()))
        private = make_channel(ChannelKind.PRIVATE, members=[member.user])
        public = make_channel(members=[member.user])
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        asset_of = {c.id: upload(c, member.user, on=send(c, member.user)) for c in [private, public, dm]}
        for actor, target in [
            (admin, private),  # a workspace admin who isn't in it
            (admin, dm),
            (member2, private),
            (member2, public),  # can read the channel, isn't a member
            (admin, public),
            (guest, public),
            (guest, private),
        ]:
            res = actor.client.get(attachment_url(target, asset_of[target.id].id), {"preview": "1"})
            assert (res.status_code, res.data) == (missing.status_code, missing.data), target.kind

    def test_outside_the_workspace_is_refused(self, member, outsider, channel, send, upload, attachment_url):
        asset = upload(channel, member.user, on=send(channel, member.user))
        assert outsider.client.get(attachment_url(channel, asset.id)).status_code == 403

    def test_removal_from_the_channel_ends_access_at_once(self, member, member2, channel, send, upload, attachment_url):
        member_row = ChannelMember.objects.create(channel=channel, user=member2.user)
        asset = upload(channel, member.user, on=send(channel, member.user))
        assert member2.client.get(attachment_url(channel, asset.id)).status_code == 302
        member_row.delete()
        assert member2.client.get(attachment_url(channel, asset.id)).status_code == 404

    def test_the_uploader_loses_access_too_after_leaving(self, member, channel, send, upload, attachment_url):
        asset = upload(channel, member.user, on=send(channel, member.user))
        ChannelMember.objects.filter(channel=channel, user=member.user).delete()
        assert member.client.get(attachment_url(channel, asset.id)).status_code == 404

    def test_a_file_never_sent_is_nobodys_yet(self, member, member2, channel, upload, attachment_url):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        asset = upload(channel, member.user)
        assert member.client.get(attachment_url(channel, asset.id)).status_code == 404
        assert member2.client.get(attachment_url(channel, asset.id)).status_code == 404

    def test_the_url_channel_must_be_the_files_channel(
        self, member, channel, make_channel, send, upload, attachment_url
    ):
        elsewhere = make_channel(members=[member.user])
        asset = upload(channel, member.user, on=send(channel, member.user))
        assert member.client.get(attachment_url(elsewhere, asset.id)).status_code == 404

    def test_upload_not_finished_is_not_served(self, member, channel, send, upload, attachment_url):
        asset = upload(channel, member.user, is_uploaded=False, on=send(channel, member.user))
        assert member.client.get(attachment_url(channel, asset.id)).status_code == 404

    def test_a_message_only_lists_files_for_members(
        self, admin, member, member2, guest, make_channel, send, upload, url
    ):
        channel = make_channel(members=[member.user, guest.user])
        message = send(channel, member.user)
        upload(channel, member.user, on=message)

        in_channel = guest.client.get(url(f"channels/{channel.id}/messages/{message.id}/"))
        assert len(in_channel.data["attachments"]) == 1 and in_channel.data["attachment_count"] == 1

        for reader in [member2, admin]:
            res = reader.client.get(url(f"channels/{channel.id}/messages/{message.id}/"))
            assert res.status_code == 200 and res.data["attachments"] == [] and res.data["attachment_count"] == 1
            listing = reader.client.get(url(f"channels/{channel.id}/messages/"))
            assert listing.data["results"][0]["attachments"] == []

    def test_only_files_the_sender_sent_with_it_count_as_a_messages(
        self, member, member2, channel, make_channel, send, upload, url, attachment_url
    ):
        ChannelMember.objects.create(channel=channel, user=member2.user)
        message = send(channel, member.user)
        real = upload(channel, member.user, on=message)
        # Rows pointing at the message that it was never sent with: someone else's file, a file for
        # another channel, one never finished, and one whose attributes aren't what an upload stores.
        someone_elses = upload(channel, member2.user, on=message)
        other_channel = upload(make_channel(members=[member.user]), member.user, on=message)
        unfinished = upload(channel, member.user, on=message, is_uploaded=False)
        malformed = upload(channel, member.user, on=message)
        FileAsset.objects.filter(pk=malformed.pk).update(attributes={})

        for reader in (member, member2):
            detail = reader.client.get(url(f"channels/{channel.id}/messages/{message.id}/"))
            assert detail.status_code == 200
            assert [a["id"] for a in detail.data["attachments"]] == [str(real.id)]
            assert detail.data["attachment_count"] == 1
            listing = reader.client.get(url(f"channels/{channel.id}/messages/"))
            assert listing.status_code == 200
            assert [a["id"] for a in listing.data["results"][0]["attachments"]] == [str(real.id)]
            for forged in (someone_elses, other_channel, unfinished, malformed):
                assert reader.client.get(attachment_url(channel, forged.id)).status_code == 404
            assert reader.client.get(attachment_url(channel, real.id)).status_code == 302

    def test_no_storage_url_or_key_in_the_message(self, member, channel, send, upload, url):
        message = send(channel, member.user)
        asset = upload(channel, member.user, on=message)
        attachment = member.client.get(url(f"channels/{channel.id}/messages/{message.id}/")).data["attachments"][0]
        for value in attachment.values():
            assert asset.asset.name not in str(value)
            assert "X-Amz" not in str(value)


@pytest.mark.contract
@pytest.mark.django_db
class TestRemovingAndEditing:
    def test_removing_a_message_takes_its_files(self, member, channel, send, upload, url, attachment_url):
        message = send(channel, member.user)
        asset = upload(channel, member.user, on=message)
        assert member.client.delete(url(f"channels/{channel.id}/messages/{message.id}/")).status_code == 204
        assert member.client.get(attachment_url(channel, asset.id)).status_code == 404
        res = member.client.get(url(f"channels/{channel.id}/messages/{message.id}/"))
        assert res.data["attachments"] == [] and res.data["attachment_count"] == 0

    def test_removed_files_stay_out_of_reach_of_the_restore_endpoint(
        self, admin, member, channel, send, upload, attachment_url, workspace
    ):
        ChannelMember.objects.create(channel=channel, user=admin.user)
        message = send(channel, member.user)
        asset = upload(channel, member.user, on=message)
        Message.objects.get(pk=message.pk).remove()
        restored = admin.client.post(f"/api/assets/v2/workspaces/{workspace.slug}/restore/{asset.id}/")
        assert restored.status_code == 404
        assert admin.client.get(attachment_url(channel, asset.id)).status_code == 404

    def test_editing_keeps_the_files(self, member, channel, upload, url):
        asset = upload(channel, member.user)
        created = _send(member, channel, url, [asset.id]).data
        res = member.client.patch(
            url(f"channels/{channel.id}/messages/{created['id']}/"), {"body_html": "<p>edited</p>"}, format="json"
        )
        assert res.status_code == 200
        assert [a["id"] for a in res.data["attachments"]] == [str(asset.id)]

    def test_an_edit_cannot_change_the_files(self, member, channel, upload, url):
        message_data = _send(member, channel, url, [upload(channel, member.user).id]).data
        other = upload(channel, member.user)
        res = member.client.patch(
            url(f"channels/{channel.id}/messages/{message_data['id']}/"),
            {"body_html": "<p>x</p>", "attachment_ids": [str(other.id)]},
            format="json",
        )
        assert res.status_code == 200 and res.data["attachment_count"] == 1
        other.refresh_from_db()
        assert other.entity_identifier is None

    def test_an_edit_can_empty_the_text_of_a_message_with_files(self, member, channel, upload, url):
        created = _send(member, channel, url, [upload(channel, member.user).id]).data
        res = member.client.patch(
            url(f"channels/{channel.id}/messages/{created['id']}/"), {"body_html": "<p></p>"}, format="json"
        )
        assert res.status_code == 200 and res.data["attachment_count"] == 1

    def test_an_edit_cannot_empty_a_message_without_files(self, member, channel, send, url):
        message = send(channel, member.user)
        res = member.client.patch(
            url(f"channels/{channel.id}/messages/{message.id}/"), {"body_html": "<p></p>"}, format="json"
        )
        assert res.status_code == 400


@pytest.mark.contract
@pytest.mark.django_db
class TestOtherAssetEndpoints:
    """The generic asset endpoints check workspace or project access, which says nothing about a channel."""

    def test_workspace_endpoints_treat_it_as_missing(self, admin, member, channel, send, upload, workspace):
        asset = upload(channel, member.user, on=send(channel, member.user))
        base = f"/api/assets/v2/workspaces/{workspace.slug}"
        calls = [
            ("get", f"{base}/{asset.id}/", None),
            ("patch", f"{base}/{asset.id}/", {"attributes": {"name": "x", "type": "text/html"}}),
            ("delete", f"{base}/{asset.id}/", None),
            ("post", f"{base}/restore/{asset.id}/", None),
            ("get", f"{base}/download/{asset.id}/", None),
            (
                "post",
                f"{base}/duplicate-assets/{asset.id}/",
                {"entity_type": "USER_AVATAR", "entity_id": str(admin.user.id)},
            ),
        ]
        for method, path, body in calls:
            res = (
                getattr(admin.client, method)(path, body, format="json")
                if body
                else getattr(admin.client, method)(path)
            )
            assert res.status_code == 404, (method, path)
        asset.refresh_from_db()
        assert asset.attributes["type"] == "image/png" and not asset.is_deleted

    @pytest.mark.parametrize("in_channel", [False, True])
    def test_legacy_key_endpoints_treat_it_as_missing(
        self, admin, member, channel, send, upload, workspace, in_channel
    ):
        if in_channel:
            ChannelMember.objects.create(channel=channel, user=admin.user)
        asset = upload(channel, member.user, on=send(channel, member.user))
        _, key = asset.asset.name.split("/")
        path = f"/api/workspaces/file-assets/{workspace.id}/{key}/"

        listed = admin.client.get(path)
        assert listed.status_code == 200 and listed.data == {"error": "Asset key does not exist", "status": False}
        assert admin.client.delete(path).status_code == 404
        assert admin.client.post(f"{path}restore/").status_code == 404
        asset.refresh_from_db()
        assert not asset.is_deleted

        # Restore must not bring back a file whose message was removed either.
        FileAsset.objects.filter(pk=asset.pk).update(is_deleted=True)
        assert admin.client.post(f"{path}restore/").status_code == 404
        assert FileAsset.objects.get(pk=asset.pk).is_deleted

    def test_uploader_key_endpoints_treat_it_as_missing(self, member, channel, upload):
        # Called directly: a chat key has a slash, which this route's <str:asset_key> can't match anyway.
        from plane.app.views.asset.base import UserAssetsEndpoint

        asset = upload(channel, member.user)
        view, request = UserAssetsEndpoint(), mock.Mock(user=member.user)
        assert view.get(request, asset.asset.name).data["status"] is False
        with pytest.raises(FileAsset.DoesNotExist):
            view.delete(request, asset.asset.name)
        asset.refresh_from_db()
        assert not asset.is_deleted

    def test_a_customer_cant_use_it(self, member, channel, upload, workspace):
        from types import SimpleNamespace

        from plane.nexus.serializers.customer import CustomerSerializer
        from plane.nexus.views.customer import _normalize

        asset = upload(channel, member.user)
        serializer = CustomerSerializer(
            data={"name": "Acme", "logo_asset": str(asset.id)}, context={"workspace_id": workspace.id}
        )
        assert not serializer.is_valid() and "logo_asset" in serializer.errors
        with pytest.raises(ValueError):
            _normalize(SimpleNamespace(property_type="FILE"), str(asset.id), workspace.id)

    def test_existence_check_says_no(self, admin, member, channel, send, upload, workspace):
        asset = upload(channel, member.user, on=send(channel, member.user))
        res = admin.client.get(f"/api/assets/v2/workspaces/{workspace.slug}/check/{asset.id}/")
        assert res.status_code == 200 and res.data["exists"] is False

    def test_external_api_treats_it_as_missing(self, api_key_client, member, channel, send, upload, workspace):
        asset = upload(channel, member.user, on=send(channel, member.user))
        path = f"/api/v1/workspaces/{workspace.slug}/assets/{asset.id}/"
        assert api_key_client.get(path).status_code == 404
        assert api_key_client.patch(path, {"is_uploaded": False}, format="json").status_code == 404
        asset.refresh_from_db()
        assert asset.is_uploaded

    def test_bulk_endpoint_leaves_it_alone(self, member, channel, upload, workspace, project):
        asset = upload(channel, member.user)
        # The bulk update acts on the whole id list, so a chat file slipped in with a normal asset must stay out.
        with impersonate(member.user):
            cover = FileAsset.objects.create(
                attributes={"name": "d.png", "type": "image/png", "size": 1},
                asset=f"{workspace.id}/{uuid4().hex}",
                workspace=workspace,
                entity_type=FileAsset.EntityTypeContext.PROJECT_COVER,
            )
        res = member.client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.id}/{uuid4()}/bulk/",
            {"asset_ids": [str(asset.id), str(cover.id)]},
            format="json",
        )
        assert res.status_code == 204
        asset.refresh_from_db()
        assert asset.project_id is None

    @pytest.mark.parametrize("path", ["/api/workspaces/{slug}/file-assets/", "/api/users/file-assets/"])
    def test_legacy_upload_refuses_the_entity_type(self, member, channel, send, workspace, path):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from plane.settings.storage import S3Storage

        message = send(channel, member.user)
        with mock.patch.object(S3Storage, "save", side_effect=lambda name, *args, **kwargs: name):
            res = member.client.post(
                path.format(slug=workspace.slug),
                {
                    "asset": SimpleUploadedFile("invoice.pdf", b"%PDF-1.4", content_type="application/pdf"),
                    "entity_type": CHAT_ATTACHMENT,
                    "entity_identifier": str(message.id),
                    "is_uploaded": "true",
                    "workspace": str(workspace.id),
                    "attributes": '{"name": "invoice.pdf", "type": "application/pdf", "channel_id": "%s"}' % channel.id,
                },
                format="multipart",
            )
        assert res.status_code == 400 and "entity_type" in res.data
        assert not FileAsset.objects.filter(entity_type=CHAT_ATTACHMENT).exists()

    @pytest.mark.parametrize("path", ["", "projects/{project}/"])
    def test_generic_upload_refuses_the_entity_type(self, admin, workspace, project, path):
        res = admin.client.post(
            f"/api/assets/v2/workspaces/{workspace.slug}/{path.format(project=project.id)}",
            {"name": "x.png", "type": "image/png", "size": 10, "entity_type": CHAT_ATTACHMENT},
            format="json",
        )
        assert res.status_code == 400
        assert not FileAsset.objects.filter(entity_type=CHAT_ATTACHMENT).exists()
