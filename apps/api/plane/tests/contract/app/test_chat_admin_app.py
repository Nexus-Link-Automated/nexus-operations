# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""God mode's Messages settings and exports.

GET/PATCH /api/instances/chat/settings/
GET/POST  /api/instances/chat/exports/
GET       /api/instances/chat/exports/<uuid:pk>/download/

Instance admins only: a workspace admin, a member and an anonymous caller are all refused.
"""

import io
import json
import uuid
import zipfile
from datetime import timedelta
from unittest import mock

import pytest
from crum import impersonate
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.celery import app
from plane.chat.export import build_message_export, delete_expired_exports
from plane.chat.models import (
    Channel,
    ChannelAgent,
    ChannelKind,
    ChannelMember,
    Message,
    MessageExport,
    MessageExportStatus,
)
from plane.chat.retention import RETENTION_DAYS_HELP, RETENTION_KEY
from plane.db.models import FileAsset, User, WorkspaceMember
from plane.license.models import AgentDefinition, Instance, InstanceAdmin, InstanceConfiguration

SETTINGS_URL = "/api/instances/chat/settings/"
EXPORTS_URL = "/api/instances/chat/exports/"
CONFIGURATIONS_URL = "/api/instances/configurations/"


def _download_url(export_id):
    return f"{EXPORTS_URL}{export_id}/download/"


@pytest.fixture
def instance(db):
    instance = Instance.objects.first()
    if instance is None:
        instance = Instance.objects.create(
            instance_name="Test Instance",
            instance_id=str(uuid.uuid4()),
            current_version="1.0.0",
            domain="http://localhost:8000",
            last_checked_at=timezone.now(),
            is_setup_done=True,
        )
    return instance


@pytest.fixture
def god(db, instance):
    """An instance admin who is in no workspace."""
    user = User.objects.create(email="god@example.com", username=f"god-{uuid.uuid4().hex[:8]}")
    InstanceAdmin.objects.create(instance=instance, user=user, role=20)
    client = APIClient()
    client.force_authenticate(user=user)
    client.user = user
    return client


@pytest.fixture
def workspace_admin(session_client, workspace, instance):
    """The workspace's owner and admin, who isn't an instance admin."""
    return session_client


@pytest.fixture
def workspace_member(db, workspace, instance):
    user = User.objects.create(email="member@example.com", username=f"m-{uuid.uuid4().hex[:8]}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def anonymous(db, instance):
    return APIClient()


REFUSED = (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)


@pytest.mark.contract
class TestRefused:
    @pytest.mark.parametrize("caller", ["workspace_admin", "workspace_member", "anonymous"])
    def test_everything_is_refused_but_to_instance_admins(self, request, caller, workspace, god):
        client = request.getfixturevalue(caller)
        export = MessageExport.objects.create(
            workspace=workspace,
            workspace_slug=workspace.slug,
            workspace_name=workspace.name,
            requested_by_email="god@example.com",
            status=MessageExportStatus.READY,
            storage_key="chat-exports/x.zip",
            expires_at=timezone.now() + timedelta(hours=1),
        )
        with mock.patch("plane.chat.export.build_message_export.delay") as queued:
            assert client.get(SETTINGS_URL).status_code in REFUSED
            assert client.patch(SETTINGS_URL, {"retention_days": 30}, format="json").status_code in REFUSED
            assert client.get(EXPORTS_URL).status_code in REFUSED
            created = client.post(EXPORTS_URL, {"workspace_id": str(workspace.id)}, format="json")
            assert created.status_code in REFUSED
            assert client.get(_download_url(export.id)).status_code in REFUSED
        assert not queued.called
        assert MessageExport.objects.count() == 1
        assert not InstanceConfiguration.objects.filter(key=RETENTION_KEY).exists()


@pytest.mark.contract
class TestRetentionSetting:
    def test_forever_until_set(self, god):
        response = god.get(SETTINGS_URL)
        assert response.status_code == 200
        assert response.data["retention_days"] == 0
        assert response.data["min_retention_days"] == 30
        assert response.data["rate_limits"]["send"] == ["30/minute", "500/hour"]
        assert response.data["rate_limits"]["agent_session"] == ["5/minute", "60/hour"]
        assert response.data["rate_limits"]["agent_post"] == ["120/hour"]
        assert response.data["agent_reply_timeout_seconds"] == 300

    @pytest.mark.parametrize("value, stored", [(30, "30"), ("365", "365"), (0, "0")])
    def test_set(self, god, value, stored):
        response = god.patch(SETTINGS_URL, {"retention_days": value}, format="json")
        assert response.status_code == 200
        assert InstanceConfiguration.objects.get(key=RETENTION_KEY).value == stored
        assert god.get(SETTINGS_URL).data["retention_days"] == int(stored)

    @pytest.mark.parametrize("value", [29, 1, -30, "abc", 36501, True, None, 30.5])
    def test_invalid_is_refused_and_keeps_the_setting(self, god, value):
        god.patch(SETTINGS_URL, {"retention_days": 90}, format="json")
        response = god.patch(SETTINGS_URL, {"retention_days": value}, format="json")
        assert response.status_code == 400
        assert InstanceConfiguration.objects.get(key=RETENTION_KEY).value == "90"
        assert response.data == {"error": RETENTION_DAYS_HELP}

    def test_required(self, god):
        assert god.patch(SETTINGS_URL, {}, format="json").status_code == 400

    def test_the_generic_configuration_endpoint_checks_it_too(self, god):
        InstanceConfiguration.objects.create(key=RETENTION_KEY, value="0", category="CHAT")
        refused = god.patch(CONFIGURATIONS_URL, {RETENTION_KEY: "5"}, format="json")
        assert refused.status_code == 400
        assert refused.data == {"error": RETENTION_DAYS_HELP}
        assert InstanceConfiguration.objects.get(key=RETENTION_KEY).value == "0"
        assert god.patch(CONFIGURATIONS_URL, {RETENTION_KEY: " 60 "}, format="json").status_code == 200
        assert InstanceConfiguration.objects.get(key=RETENTION_KEY).value == "60"


@pytest.fixture
def channels(workspace, create_user):
    """One of each kind, with a message in each, and a deleted public channel."""
    other = User.objects.create(email="other@example.com", username=f"o-{uuid.uuid4().hex[:8]}", display_name="Other")
    WorkspaceMember.objects.create(workspace=workspace, member=other, role=15)
    public = Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="general")
    private = Channel.objects.create(workspace=workspace, kind=ChannelKind.PRIVATE, name="secret")
    deleted = Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="gone")
    for channel in (public, private, deleted):
        ChannelMember.objects.create(channel=channel, user=create_user)
    dm, _ = Channel.objects.get_or_create_dm(workspace, create_user, other)
    messages = {}
    for channel in (public, private, dm, deleted):
        messages[channel.kind if channel != deleted else "deleted"] = Message.objects.create(
            channel=channel, sender=create_user, body_html=f"<p>hello <b>{channel.name or 'dm'}</b></p>"
        )
    Channel.all_objects.filter(pk=deleted.pk).update(deleted_at=timezone.now())
    reply = Message.objects.create(channel=public, sender=other, parent=messages["public"], body_html="<p>reply</p>")
    with impersonate(create_user):
        FileAsset.objects.create(
            attributes={"name": "plan.pdf", "type": "application/pdf", "size": 2048, "channel_id": str(public.id)},
            asset=f"{workspace.id}/{uuid.uuid4().hex}",
            workspace=workspace,
            entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT,
            entity_identifier=str(messages["public"].id),
            is_uploaded=True,
        )
    return {"public": public, "private": private, "dm": dm, "messages": messages, "reply": reply, "other": other}


@pytest.fixture
def stored():
    """What the export task put in storage, by key."""
    objects = {}

    def upload_file(file, key, content_type=None):
        objects[key] = (file.read(), content_type)
        return True

    with mock.patch("plane.chat.export.S3Storage") as storage_class:
        storage_class.return_value.upload_file.side_effect = upload_file
        yield objects


def _start(client, workspace, django_capture_on_commit_callbacks, **body):
    with (
        mock.patch("plane.chat.export.build_message_export.delay") as queued,
        django_capture_on_commit_callbacks(execute=True),
    ):
        response = client.post(EXPORTS_URL, {"workspace_id": str(workspace.id), **body}, format="json")
    return response, queued


def _archive(stored):
    (data, content_type), *rest = stored.values()
    assert not rest and content_type == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(data))

    def lines(name):
        return [json.loads(line) for line in archive.read(name).decode().splitlines()]

    return (
        json.loads(archive.read("export.json")),
        {name.removesuffix(".jsonl"): lines(name) for name in archive.namelist() if name.endswith(".jsonl")},
    )


@pytest.mark.contract
class TestExports:
    def test_start_queues_the_task_and_records_who_and_what(self, god, workspace, django_capture_on_commit_callbacks):
        response, queued = _start(god, workspace, django_capture_on_commit_callbacks)
        assert response.status_code == 201
        export = MessageExport.objects.get()
        queued.assert_called_once_with(str(export.id))
        assert export.requested_by == god.user
        assert export.requested_by_email == "god@example.com"
        assert export.include_private is False
        assert export.status == MessageExportStatus.QUEUED
        assert response.data["can_download"] is False

        listed = god.get(EXPORTS_URL).data
        assert [row["id"] for row in listed] == [str(export.id)]
        assert listed[0]["workspace_slug"] == workspace.slug

    def test_one_at_a_time_per_workspace(self, god, workspace, django_capture_on_commit_callbacks):
        _start(god, workspace, django_capture_on_commit_callbacks)
        again, queued = _start(god, workspace, django_capture_on_commit_callbacks)
        assert again.status_code == 409
        assert not queued.called

    @pytest.mark.parametrize("stuck", [MessageExportStatus.QUEUED, MessageExportStatus.RUNNING])
    def test_one_stuck_since_long_ago_doesnt_block_the_next(
        self, god, workspace, django_capture_on_commit_callbacks, stuck
    ):
        # Its worker was lost (a restart mid-build), or the task never reached one.
        _start(god, workspace, django_capture_on_commit_callbacks)
        MessageExport.objects.update(status=stuck, created_at=timezone.now() - timedelta(hours=7))
        again, queued = _start(god, workspace, django_capture_on_commit_callbacks)
        assert again.status_code == 201
        assert queued.called

    def test_unknown_workspace(self, god, django_capture_on_commit_callbacks):
        response = god.post(EXPORTS_URL, {"workspace_id": str(uuid.uuid4())}, format="json")
        assert response.status_code == 404
        assert god.post(EXPORTS_URL, {"workspace_id": "nope"}, format="json").status_code == 400

    def test_public_channels_only_by_default(
        self, god, workspace, channels, stored, django_capture_on_commit_callbacks
    ):
        _start(god, workspace, django_capture_on_commit_callbacks)
        build_message_export(str(MessageExport.objects.get().id))
        summary, files = _archive(stored)

        assert [channel["name"] for channel in files["channels"]] == ["general"]
        assert {message["channel_id"] for message in files["messages"]} == {str(channels["public"].id)}
        assert summary["include_private"] is False
        assert summary["counts"] == {"channels": 1, "messages": 2}
        assert summary["workspace"]["slug"] == workspace.slug
        assert summary["requested_by"] == "god@example.com"

    def test_private_channels_and_dms_when_asked(
        self, god, workspace, channels, stored, django_capture_on_commit_callbacks
    ):
        _start(god, workspace, django_capture_on_commit_callbacks, include_private=True)
        build_message_export(str(MessageExport.objects.get().id))
        summary, files = _archive(stored)

        assert {channel["kind"] for channel in files["channels"]} == {"public", "private", "dm"}
        # The deleted channel isn't in it, even asked for everything.
        assert "gone" not in {channel["name"] for channel in files["channels"]}
        assert summary["counts"] == {"channels": 3, "messages": 4}

    def test_what_a_message_carries(self, god, workspace, channels, stored, django_capture_on_commit_callbacks):
        _start(god, workspace, django_capture_on_commit_callbacks)
        build_message_export(str(MessageExport.objects.get().id))
        _, files = _archive(stored)

        first, reply = files["messages"]
        assert first["body_text"] == "hello general"
        assert first["body_html"] == "<p>hello <b>general</b></p>"
        assert first["parent_id"] is None and reply["parent_id"] == first["id"]
        assert first["created_at"] and first["edited_at"] is None
        assert first["attachments"] == [{"id": mock.ANY, "name": "plan.pdf", "type": "application/pdf", "size": 2048}]
        assert {member["user_id"] for member in files["members"]} == {str(channels["messages"]["public"].sender_id)}
        people = {person["id"]: person for person in files["users"]}
        assert people[str(channels["other"].id)]["display_name"] == "Other"
        assert set(people) == {str(channels["messages"]["public"].sender_id), str(channels["other"].id)}

    def test_agent_members_are_in_it_marked_as_agents(
        self, god, workspace, channels, stored, django_capture_on_commit_callbacks
    ):
        agent = AgentDefinition.objects.create(name="Release bot", slug="release-bot", adapter="codex")
        adder = User.objects.create(
            email="adder@example.com", username=f"a-{uuid.uuid4().hex[:8]}", display_name="Adder"
        )
        seat = ChannelAgent(channel=channels["public"], agent=agent, permission_level="ask_all")
        seat.save(created_by_id=adder.id)
        ChannelAgent(channel=channels["private"], agent=agent, permission_level="ask_all").save()
        _start(god, workspace, django_capture_on_commit_callbacks)
        build_message_export(str(MessageExport.objects.get().id))
        _, files = _archive(stored)

        people_rows = [row for row in files["members"] if row["member_type"] == "user"]
        agent_rows = [row for row in files["members"] if row["member_type"] == "agent"]
        assert [row["user_id"] for row in people_rows] == [str(channels["messages"]["public"].sender_id)]
        # The private channel's agent isn't in a public-only export.
        assert agent_rows == [
            {
                "channel_id": str(channels["public"].id),
                "member_type": "agent",
                "agent_id": str(agent.id),
                "agent_slug": "release-bot",
                "agent_name": "Release bot",
                "permission_level": "ask_all",
                "is_available": True,
                "added_by_id": str(adder.id),
                "joined_at": seat.created_at.isoformat(),
            }
        ]
        # Who added it is named in users.jsonl, like everyone the other files mention.
        assert {person["id"]: person["display_name"] for person in files["users"]}[str(adder.id)] == "Adder"

    def test_ready_then_downloaded_through_a_short_lived_link(
        self, god, workspace, channels, stored, django_capture_on_commit_callbacks
    ):
        _start(god, workspace, django_capture_on_commit_callbacks)
        export = MessageExport.objects.get()
        build_message_export(str(export.id))
        export.refresh_from_db()
        assert export.status == MessageExportStatus.READY
        assert export.storage_key in stored
        assert export.size == len(stored[export.storage_key][0])
        assert timedelta(hours=23) < export.expires_at - export.completed_at <= timedelta(hours=24)

        with mock.patch("plane.license.api.views.chat.S3Storage") as storage_class:
            storage_class.return_value.generate_presigned_url.return_value = "https://storage.example/signed"
            response = god.get(_download_url(export.id))
        assert response.status_code == 200
        assert response.data == {"url": "https://storage.example/signed", "expires_in": 60}
        assert response["Cache-Control"] == "no-store"
        kwargs = storage_class.return_value.generate_presigned_url.call_args.kwargs
        assert kwargs["object_name"] == export.storage_key
        assert kwargs["expiration"] == 60
        assert kwargs["disposition"] == "attachment"

    def test_only_a_ready_unexpired_export_downloads(self, god, workspace):
        def export(**fields):
            return MessageExport.objects.create(
                workspace=workspace, workspace_slug=workspace.slug, workspace_name=workspace.name, **fields
            )

        never_ready = export(status=MessageExportStatus.RUNNING)
        expired = export(
            status=MessageExportStatus.READY, storage_key="k", expires_at=timezone.now() - timedelta(minutes=1)
        )
        with mock.patch("plane.license.api.views.chat.S3Storage") as storage_class:
            storage_class.return_value.generate_presigned_url.return_value = "https://storage.example/signed"
            for unavailable in (never_ready, expired):
                assert god.get(_download_url(unavailable.id)).status_code == 404
            assert god.get(_download_url(uuid.uuid4())).status_code == 404
        assert not storage_class.called

    def test_a_failure_is_recorded(self, god, workspace, channels, django_capture_on_commit_callbacks):
        _start(god, workspace, django_capture_on_commit_callbacks)
        export = MessageExport.objects.get()
        with mock.patch("plane.chat.export.S3Storage") as storage_class:
            storage_class.return_value.upload_file.return_value = False
            build_message_export(str(export.id))
        export.refresh_from_db()
        assert export.status == MessageExportStatus.FAILED
        assert not export.storage_key

    def test_a_task_delivered_twice_builds_once(
        self, god, workspace, channels, stored, django_capture_on_commit_callbacks
    ):
        _start(god, workspace, django_capture_on_commit_callbacks)
        export = MessageExport.objects.get()
        build_message_export(str(export.id))
        stored.clear()
        build_message_export(str(export.id))
        assert stored == {}


@pytest.mark.contract
class TestExpiry:
    def _export(self, workspace, expires_in):
        return MessageExport.objects.create(
            workspace=workspace,
            workspace_slug=workspace.slug,
            workspace_name=workspace.name,
            status=MessageExportStatus.READY,
            storage_key=f"chat-exports/{uuid.uuid4()}.zip",
            expires_at=timezone.now() + expires_in,
        )

    def test_the_archive_is_deleted_and_the_record_stays(self, workspace):
        due = self._export(workspace, timedelta(minutes=-1))
        not_yet = self._export(workspace, timedelta(hours=1))
        key = due.storage_key
        with mock.patch("plane.chat.retention.S3Storage") as storage_class:
            storage_class.return_value.s3_client.delete_objects.return_value = {}
            delete_expired_exports()
            deleted = storage_class.return_value.s3_client.delete_objects.call_args.kwargs["Delete"]["Objects"]
        assert deleted == [{"Key": key}]
        due.refresh_from_db()
        not_yet.refresh_from_db()
        assert (due.status, due.storage_key) == (MessageExportStatus.EXPIRED, "")
        assert not_yet.status == MessageExportStatus.READY

    def test_kept_for_retry_if_storage_refuses(self, workspace):
        due = self._export(workspace, timedelta(minutes=-1))
        with mock.patch("plane.chat.retention.S3Storage") as storage_class:
            storage_class.return_value.s3_client.delete_objects.return_value = {"Errors": [{"Key": due.storage_key}]}
            delete_expired_exports()
        due.refresh_from_db()
        assert due.status == MessageExportStatus.READY

    def test_one_stuck_is_marked_failed(self, workspace):
        def export(status, hours_ago):
            return MessageExport.objects.create(
                workspace=workspace,
                workspace_slug=workspace.slug,
                workspace_name=workspace.name,
                status=status,
                created_at=timezone.now() - timedelta(hours=hours_ago),
            )

        stuck, running = export(MessageExportStatus.RUNNING, 7), export(MessageExportStatus.RUNNING, 1)
        lost = export(MessageExportStatus.QUEUED, 7)
        delete_expired_exports()
        for row in (stuck, running, lost):
            row.refresh_from_db()
        assert (stuck.status, lost.status) == (MessageExportStatus.FAILED, MessageExportStatus.FAILED)
        assert stuck.completed_at is not None
        assert running.status == MessageExportStatus.RUNNING

    def test_scheduled(self):
        tasks = {entry["task"] for entry in app.conf.beat_schedule.values()}
        assert delete_expired_exports.name in tasks
