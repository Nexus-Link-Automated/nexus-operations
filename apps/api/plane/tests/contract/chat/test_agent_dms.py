# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent DMs: who can open and see one, what starts a turn, the streamed reply, approvals and Stop.

The agent bridge is replaced by a stub of its internal routes; the bridge's own tests cover the sessions.
"""

import io
import json
import zipfile
from datetime import timedelta
from unittest import mock
from uuid import uuid4

import pytest
import requests
from crum import impersonate
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.chat import agent_dm, agent_replies
from plane.chat.agent_dm import (
    respond_in_agent_dm,
    start_dm_turn,
    start_queued_dm_turn,
    turn_lock_key,
)
from plane.chat.export import write_archive
from plane.chat.models import (
    AgentDmSession,
    AgentNotice,
    AgentPermissionRequest,
    AgentPermissionStatus,
    Channel,
    ChannelAgent,
    ChannelKind,
    ChannelMember,
    Message,
    MessageExport,
)
from plane.chat.notifications import CHAT_MESSAGE_ENTITY
from plane.db.models import FileAsset, Notification, WorkspaceMember
from plane.license.models import AgentDefinition

from .conftest import GUEST

BRIDGE = "http://agent-bridge.test:3400"
SECRET = "bridge-secret-for-tests"
REPLIES_URL = "/api/internal/chat/agent-replies/"
DRAFT_URL = "/api/internal/chat/agent-replies/draft/"
PERMISSION_URL = "/api/internal/chat/agent-replies/permission/"
OPTIONS = [
    {"option_id": "allow", "name": "Allow once", "kind": "allow_once"},
    {"option_id": "always", "name": "Always allow", "kind": "allow_always"},
    {"option_id": "reject", "name": "Reject", "kind": "reject_once"},
]


@pytest.fixture(autouse=True)
def bridge_settings(settings):
    settings.AGENT_BRIDGE_INTERNAL_URL = BRIDGE
    settings.AGENT_BRIDGE_SECRET = SECRET
    settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS = 300


@pytest.fixture(autouse=True)
def clean_runs():
    cache.delete_pattern("chat:agent-*")
    yield
    cache.delete_pattern("chat:agent-*")


class StubBridge:
    """`requests.post` to the bridge: records each call, answers by route (`statuses`), or raises `error`."""

    def __init__(self):
        self.calls = []
        self.statuses = {"dm-turns": 202, "permissions": 204, "cancel": 202}
        self.error = None

    def __call__(self, url, data=None, headers=None, **kwargs):
        if self.error:
            raise self.error
        self.calls.append({"url": url, "headers": headers, "body": json.loads(data)})
        response = mock.Mock()
        if "/permissions/" in url:
            response.status_code = self.statuses["permissions"]
        elif url.endswith("/cancel"):
            response.status_code = self.statuses["cancel"]
        else:
            response.status_code = self.statuses["dm-turns"]
        return response

    @property
    def turns(self):
        return [call["body"] for call in self.calls if call["url"] == f"{BRIDGE}/internal/dm-turns"]


@pytest.fixture
def expiry():
    with mock.patch.object(agent_replies.expire_run, "apply_async") as queued:
        yield queued


@pytest.fixture
def bridge(expiry):
    stub = StubBridge()
    with mock.patch.object(agent_dm.requests, "post", stub):
        yield stub


@pytest.fixture
def make_agent(db):
    def make(name="Maia", enabled=True, default="ask_writes", maximum="ask_writes"):
        return AgentDefinition.objects.create(
            name=name,
            slug=f"agent-{uuid4().hex[:8]}",
            adapter="claude",
            default_permission_level=default,
            max_permission_level=maximum,
            is_enabled=enabled,
        )

    return make


@pytest.fixture
def agent(make_agent):
    return make_agent(default="ask_all", maximum="ask_writes")


@pytest.fixture
def dm(member, agent, workspace):
    channel, _ = Channel.objects.get_or_create_agent_dm(workspace, member.user, agent, agent.default_permission_level)
    return channel


@pytest.fixture
def say(dm, member):
    def say(text="what's left for the release?", parent=None):
        return Message.objects.create(channel=dm, sender=member.user, parent=parent, body_html=f"<p>{text}</p>")

    return say


def internal(client, path, body, secret=SECRET):
    headers = {"HTTP_X_AGENT_BRIDGE_SECRET": secret} if secret is not None else {}
    return client.post(path, body, format="json", **headers)


def agent_messages(channel):
    return list(Message.objects.filter(channel=channel, sender_agent__isnull=False).order_by("created_at", "id"))


@pytest.fixture
def turn(say, bridge):
    """A turn running for a new message; returns (the message, the run ID)."""

    def start(text="what's left for the release?"):
        message = say(text)
        respond_in_agent_dm(str(message.id))
        return message, bridge.turns[-1]["run_id"]

    return start


# ── opening and seeing one ───────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestOpening:
    def test_a_member_opens_one_at_the_agents_default_level(self, member, agent, url):
        response = member.client.post(url("agent-dms/"), {"agent_id": str(agent.id)}, format="json")
        assert response.status_code == 201
        data = response.data
        assert data["kind"] == "agent_dm"
        assert data["name"] == ""
        assert data["dm_member_ids"] == [str(member.user.id)]
        assert data["agent_dm"] == {
            "agent": {
                "id": str(agent.id),
                "slug": agent.slug,
                "name": "Maia",
                "adapter": "claude",
                "is_available": True,
            },
            "permission_level": "ask_all",
            "default_permission_level": "ask_all",
            "max_permission_level": "ask_writes",
            "responding": False,
            "read_only_reason": None,
        }
        assert ChannelAgent.objects.get(channel_id=data["id"]).created_by_id == member.user.id

    def test_one_per_person_and_agent(self, member, member2, agent, make_agent, url):
        first = member.client.post(url("agent-dms/"), {"agent_id": str(agent.id)}, format="json")
        again = member.client.post(url("agent-dms/"), {"agent_id": str(agent.id)}, format="json")
        assert again.status_code == 200
        assert again.data["id"] == first.data["id"]
        other_agent = member.client.post(url("agent-dms/"), {"agent_id": str(make_agent().id)}, format="json")
        other_person = member2.client.post(url("agent-dms/"), {"agent_id": str(agent.id)}, format="json")
        assert len({first.data["id"], other_agent.data["id"], other_person.data["id"]}) == 3

    def test_guests_cant_open_one(self, guest, agent, url):
        response = guest.client.post(url("agent-dms/"), {"agent_id": str(agent.id)}, format="json")
        assert response.status_code == 403
        assert not Channel.objects.filter(kind=ChannelKind.AGENT_DM).exists()
        assert guest.client.get(url("me/")).data["can_open_agent_dms"] is False

    def test_members_and_admins_may(self, admin, member, url):
        assert member.client.get(url("me/")).data["can_open_agent_dms"] is True
        assert admin.client.get(url("me/")).data["can_open_agent_dms"] is True

    def test_a_disabled_or_unknown_agent_cant_be_opened(self, member, make_agent, url):
        disabled = make_agent(enabled=False)
        for agent_id in (disabled.id, uuid4()):
            response = member.client.post(url("agent-dms/"), {"agent_id": str(agent_id)}, format="json")
            assert response.status_code == 400

    def test_only_its_person_sees_it(self, dm, member, member2, admin, url, say):
        say()
        assert str(dm.id) in [str(channel["id"]) for channel in member.client.get(url("channels/")).data]
        for actor in (admin, member2):
            assert str(dm.id) not in [str(channel["id"]) for channel in actor.client.get(url("channels/")).data]
            for path in ("", "messages/", "members/", "agents/", "agent-dm/permissions/"):
                assert actor.client.get(url(f"channels/{dm.id}/{path}")).status_code == 404, path
            assert actor.client.post(url(f"channels/{dm.id}/agent-dm/stop/")).status_code == 404
            assert (
                actor.client.patch(url(f"channels/{dm.id}/agent-dm/"), {"permission_level": "ask_all"}).status_code
                == 404
            )
            sent = actor.client.post(url(f"channels/{dm.id}/messages/"), {"body_html": "<p>hi</p>"}, format="json")
            assert sent.status_code == 404

    def test_someone_from_another_workspace_gets_nothing(self, dm, outsider, url):
        assert outsider.client.get(url(f"channels/{dm.id}/")).status_code == 403

    def test_its_membership_is_fixed(self, dm, member, member2, make_agent, url):
        base = url(f"channels/{dm.id}/")
        assert member.client.patch(base, {"name": "x"}, format="json").status_code == 409
        assert member.client.post(f"{base}archive/").status_code == 409
        assert member.client.post(f"{base}leave/").status_code == 409
        added = member.client.post(f"{base}members/", {"member_ids": [str(member2.user.id)]}, format="json")
        assert added.status_code == 409
        other = make_agent()
        assert member.client.post(f"{base}agents/", {"agent_id": str(other.id)}, format="json").status_code == 409
        agent_id = ChannelAgent.objects.get(channel=dm).agent_id
        assert member.client.delete(f"{base}agents/{agent_id}/").status_code == 409


@pytest.mark.contract
@pytest.mark.django_db
class TestModelRules:
    def test_a_second_agent_is_refused(self, dm, make_agent):
        with pytest.raises(ValidationError):
            ChannelAgent(channel=dm, agent=make_agent(), permission_level="ask_all").save()

    def test_nobody_else_joins(self, dm, member2):
        with pytest.raises(ValidationError):
            ChannelMember.objects.create(channel=dm, user=member2.user)

    def test_only_an_agent_message_streams(self, dm, member):
        with pytest.raises(IntegrityError), transaction.atomic():
            Message.objects.create(channel=dm, sender=member.user, body_html="<p>x</p>", agent_streaming=True)


# ── turns ────────────────────────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestTurns:
    def test_every_message_queues_a_turn_after_commit(self, dm, member, url, django_capture_on_commit_callbacks):
        with mock.patch.object(agent_dm.respond_in_agent_dm, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                response = member.client.post(
                    url(f"channels/{dm.id}/messages/"), {"body_html": "<p>no mention needed</p>"}, format="json"
                )
        assert response.status_code == 201
        delay.assert_called_once_with(str(response.data["id"]))

    def test_a_thread_reply_queues_nothing(self, dm, member, url, say, django_capture_on_commit_callbacks):
        parent = say()
        with mock.patch.object(agent_dm.respond_in_agent_dm, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                response = member.client.post(
                    url(f"channels/{dm.id}/messages/"),
                    {"body_html": "<p>a note</p>", "parent_id": str(parent.id)},
                    format="json",
                )
        assert response.status_code == 201
        delay.assert_not_called()

    def test_a_turn_runs_as_the_person_at_the_dms_level(self, dm, member, agent, workspace, turn, bridge):
        message, run_id = turn("what's left for the release?")
        [body] = bridge.turns
        assert bridge.calls[0]["headers"]["X-Agent-Bridge-Secret"] == SECRET
        assert body["run_id"] == run_id
        assert body["channel_id"] == str(dm.id)
        assert body["user_id"] == str(member.user.id)
        assert body["workspace_slug"] == workspace.slug
        assert body["agent_id"] == str(agent.id)
        assert body["permission_level"] == "ask_all"
        assert body["prompt"] == "what's left for the release?"
        assert "Maia" in body["primer"] and body["primer"].endswith("what's left for the release?")
        assert body["session_ref"] is None
        assert body["timeout_ms"] == 300_000
        assert cache.get(turn_lock_key(dm.id)) == run_id
        assert AgentDmSession.objects.get(channel=dm).prompted_until == message.created_at

    def test_agent_messages_and_replies_never_start_a_turn(self, dm, agent, say, bridge):
        reply = Message.objects.create(channel=dm, sender_agent=agent.slug, body_html="<p>hello</p>")
        respond_in_agent_dm(str(reply.id))
        respond_in_agent_dm(str(say("note", parent=say()).id))
        assert bridge.turns == []

    def test_a_message_sent_during_a_turn_waits_for_it(
        self, api_client, dm, turn, say, bridge, django_capture_on_commit_callbacks
    ):
        _, run_id = turn("alpha")
        second = say("bravo")
        third = say("charlie")
        respond_in_agent_dm(str(second.id))
        respond_in_agent_dm(str(third.id))
        assert len(bridge.turns) == 1
        with mock.patch.object(agent_dm.start_queued_dm_turn, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                internal(
                    api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "done", "session_ref": "s1"}
                )
        delay.assert_called_once_with(str(dm.id))
        start_queued_dm_turn(str(dm.id))
        follow_up = bridge.turns[-1]
        assert "bravo" in follow_up["prompt"] and "charlie" in follow_up["prompt"]
        assert "alpha" not in follow_up["prompt"]
        assert follow_up["session_ref"] == "s1"
        assert "alpha" in follow_up["primer"] and "done" in follow_up["primer"]

    def test_a_message_that_is_only_files_says_what_was_sent(self, dm, member, bridge):
        # The bridge takes no empty prompt: without this, the turn failed as "unavailable".
        message = Message.objects.create(channel=dm, sender=member.user, body_html="<p></p>")
        with impersonate(member.user):
            FileAsset.objects.create(
                attributes={"name": "plan.pdf", "type": "application/pdf", "size": 10, "channel_id": str(dm.id)},
                asset=f"{dm.workspace_id}/{uuid4().hex}",
                workspace_id=dm.workspace_id,
                entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT,
                entity_identifier=str(message.id),
                is_uploaded=True,
            )
        respond_in_agent_dm(str(message.id))
        [started] = bridge.turns
        assert "plan.pdf" in started["prompt"]
        assert agent_messages(dm) == []

    def test_nothing_new_starts_nothing(self, dm, turn, api_client, bridge):
        _, run_id = turn()
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "done"})
        assert start_dm_turn(dm) is None
        assert len(bridge.turns) == 1

    def test_too_many_turns_get_a_note(self, settings, dm, say, bridge):
        settings.CHAT_RATE_LIMITS = {**settings.CHAT_RATE_LIMITS, "agent_dm_turn": "1/hour"}
        respond_in_agent_dm(str(say("one").id))
        cache.delete(turn_lock_key(dm.id))
        respond_in_agent_dm(str(say("two").id))
        assert len(bridge.turns) == 1
        assert agent_messages(dm)[-1].agent_notice == AgentNotice.RATE_LIMITED

    def test_an_unreachable_bridge_gets_a_note_and_frees_the_dm(self, dm, say, bridge):
        bridge.error = requests.ConnectionError("down")
        respond_in_agent_dm(str(say().id))
        assert agent_messages(dm)[-1].agent_notice == AgentNotice.UNAVAILABLE
        assert cache.get(turn_lock_key(dm.id)) is None

    def test_a_turn_the_bridge_never_reports_on_ends_with_a_note(self, dm, turn, expiry):
        _, run_id = turn()
        expiry.assert_called_once()
        agent_replies.expire_run(run_id)
        assert agent_messages(dm)[-1].agent_notice == AgentNotice.FAILED
        assert cache.get(turn_lock_key(dm.id)) is None


@pytest.mark.contract
@pytest.mark.django_db
class TestReadOnly:
    def _check_read_only(self, dm, member, url, say, bridge, reason):
        payload = member.client.get(url(f"channels/{dm.id}/")).data
        assert payload["agent_dm"]["read_only_reason"] == reason
        sent = member.client.post(url(f"channels/{dm.id}/messages/"), {"body_html": "<p>hi</p>"}, format="json")
        assert sent.status_code == 409
        respond_in_agent_dm(str(say().id))
        assert bridge.turns == []
        return payload

    def test_a_disabled_agent(self, dm, agent, member, url, say, bridge):
        earlier = say("before")
        agent.is_enabled = False
        agent.save()
        payload = self._check_read_only(dm, member, url, say, bridge, "agent_unavailable")
        assert payload["agent_dm"]["agent"]["is_available"] is False
        edited = member.client.patch(
            url(f"channels/{dm.id}/messages/{earlier.id}/"), {"body_html": "<p>x</p>"}, format="json"
        )
        assert edited.status_code == 409
        level = member.client.patch(url(f"channels/{dm.id}/agent-dm/"), {"permission_level": "ask_all"})
        assert level.status_code == 409
        # Still readable.
        assert member.client.get(url(f"channels/{dm.id}/messages/")).status_code == 200

    def test_a_deleted_agent(self, dm, agent, member, url, say, bridge):
        agent.delete()
        AgentDefinition.all_objects.filter(pk=agent.pk).delete()
        payload = self._check_read_only(dm, member, url, say, bridge, "agent_removed")
        assert payload["agent_dm"]["agent"] is None
        assert payload["agent_dm"]["permission_level"] is None

    def test_a_person_made_a_guest(self, dm, member, url, say, bridge, workspace):
        WorkspaceMember.objects.filter(workspace=workspace, member=member.user).update(role=GUEST)
        self._check_read_only(dm, member, url, say, bridge, "cannot_run_agents")

    def test_enabled_again_it_takes_messages_again(self, dm, agent, member, url):
        agent.is_enabled = False
        agent.save()
        agent.is_enabled = True
        agent.save()
        sent = member.client.post(url(f"channels/{dm.id}/messages/"), {"body_html": "<p>hi</p>"}, format="json")
        assert sent.status_code == 201


@pytest.mark.contract
@pytest.mark.django_db
class TestLevel:
    def test_the_person_changes_it_up_to_the_maximum(self, dm, member, url, say, bridge):
        response = member.client.patch(url(f"channels/{dm.id}/agent-dm/"), {"permission_level": "ask_writes"})
        assert response.status_code == 200
        assert response.data["agent_dm"]["permission_level"] == "ask_writes"
        respond_in_agent_dm(str(say().id))
        assert bridge.turns[-1]["permission_level"] == "ask_writes"

    def test_not_above_the_maximum(self, dm, member, url):
        response = member.client.patch(url(f"channels/{dm.id}/agent-dm/"), {"permission_level": "yolo"})
        assert response.status_code == 400
        assert ChannelAgent.objects.get(channel=dm).permission_level == "ask_all"

    def test_a_lowered_maximum_clamps_it(self, dm, agent, member, url, say, bridge):
        member.client.patch(url(f"channels/{dm.id}/agent-dm/"), {"permission_level": "ask_writes"})
        agent.max_permission_level = "ask_all"
        agent.save()
        assert member.client.get(url(f"channels/{dm.id}/")).data["agent_dm"]["permission_level"] == "ask_all"
        respond_in_agent_dm(str(say().id))
        assert bridge.turns[-1]["permission_level"] == "ask_all"

    def test_not_in_a_channel(self, make_channel, member, url):
        channel = make_channel(members=[member.user])
        assert (
            member.client.patch(url(f"channels/{channel.id}/agent-dm/"), {"permission_level": "ask_all"}).status_code
            == 404
        )


# ── the streamed reply ───────────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestStreaming:
    def test_a_draft_then_updates_then_the_final_reply(self, api_client, dm, member, url, turn):
        _, run_id = turn()
        first = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Two items", "tool_calls": []})
        assert first.status_code == 200
        [draft] = agent_messages(dm)
        assert first.data["message_id"] == str(draft.id)
        assert draft.agent_streaming is True
        assert draft.parent_id is None
        tools = [{"id": "t1", "title": "List work items", "status": "in_progress"}]
        second = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Two items are left", "tool_calls": tools})
        assert second.data["message_id"] == str(draft.id)
        draft.refresh_from_db()
        assert draft.body_stripped == "Two items are left"
        assert draft.agent_tool_calls == tools
        # A draft is never unread.
        assert member.client.get(url(f"channels/{dm.id}/")).data["unread_count"] == 0
        assert Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY).count() == 0

        done = [{"id": "t1", "title": "List work items", "status": "completed"}]
        final = internal(
            api_client,
            REPLIES_URL,
            {"run_id": run_id, "status": "ok", "text": "Two items are left: **WEB-1**.", "tool_calls": done},
        )
        assert final.status_code == 201
        assert final.data["message_id"] == str(draft.id)
        draft.refresh_from_db()
        assert draft.agent_streaming is False
        assert "<strong>WEB-1</strong>" in draft.body_html
        assert draft.agent_tool_calls == done
        assert agent_messages(dm) == [draft]
        assert member.client.get(url(f"channels/{dm.id}/")).data["unread_count"] == 1
        [entry] = Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY)
        assert entry.receiver_id == member.user.id
        assert entry.title == "Maia replied to you"
        assert entry.data["chat_message"]["channel_kind"] == "agent_dm"
        # Once: the run is over.
        again = internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "x"})
        assert again.status_code == 404
        assert internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "more"}).status_code == 404
        assert Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY).count() == 1

    def test_the_message_api_shows_the_draft_and_its_tool_calls(self, api_client, dm, member, url, turn):
        _, run_id = turn()
        tools = [{"id": "t1", "title": "Read WEB-1", "status": "pending"}]
        internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Looking", "tool_calls": tools})
        [shown] = member.client.get(url(f"channels/{dm.id}/messages/")).data["results"][1:]
        assert shown["agent_streaming"] is True
        assert shown["agent_tool_calls"] == tools

    def test_nothing_to_show_yet_posts_nothing(self, api_client, dm, turn):
        _, run_id = turn()
        response = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "  ", "tool_calls": []})
        assert response.status_code == 200
        assert response.data["message_id"] is None
        assert agent_messages(dm) == []

    def test_a_reply_with_no_draft_is_posted_whole(self, api_client, dm, member, turn):
        _, run_id = turn()
        response = internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "Quick answer"})
        [reply] = agent_messages(dm)
        assert response.data["message_id"] == str(reply.id)
        assert reply.agent_streaming is False
        assert reply.body_stripped == "Quick answer"
        assert Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY, receiver_id=member.user.id).count() == 1

    def test_a_muted_dm_gets_no_inbox_entry(self, api_client, dm, member, turn):
        ChannelMember.objects.filter(channel=dm).update(notification_level="none")
        _, run_id = turn()
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "Quick answer"})
        assert not Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY).exists()

    def test_a_failure_keeps_what_was_written_then_says_why(self, api_client, dm, turn):
        _, run_id = turn()
        internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Half an answer"})
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "failed", "error": "timeout", "text": "Half an"})
        draft, note = agent_messages(dm)
        assert draft.agent_streaming is False
        assert draft.body_stripped == "Half an"
        assert note.agent_notice == AgentNotice.TIMEOUT
        assert cache.get(turn_lock_key(dm.id)) is None

    def test_a_stopped_turn_with_nothing_written(self, api_client, dm, turn):
        _, run_id = turn()
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "", "stop_reason": "cancelled"})
        assert agent_messages(dm)[-1].agent_notice == AgentNotice.STOPPED

    def test_the_session_is_kept_for_next_time(self, api_client, dm, turn, say, bridge):
        _, run_id = turn()
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "hi", "session_ref": "acp-1"})
        assert AgentDmSession.objects.get(channel=dm).session_ref == "acp-1"
        respond_in_agent_dm(str(say("again").id))
        assert bridge.turns[-1]["session_ref"] == "acp-1"

    def test_a_disabled_agent_stops_posting(self, api_client, dm, agent, turn, member):
        _, run_id = turn()
        internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Working"})
        agent.is_enabled = False
        agent.save()
        response = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Working on it"})
        assert response.status_code == 409
        final = internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "Done"})
        assert final.status_code == 409
        [draft] = agent_messages(dm)
        assert draft.agent_streaming is False
        assert draft.body_stripped == "Working"
        assert not Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY).exists()
        assert cache.get(turn_lock_key(dm.id)) is None

    def test_a_run_that_no_longer_holds_the_dm_cant_post(self, api_client, dm, turn):
        _, run_id = turn()
        # Its time ran out and another turn has the DM now.
        cache.set(turn_lock_key(dm.id), uuid4().hex)
        assert internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "late"}).status_code == 409
        body = {"run_id": run_id, "request_id": uuid4().hex, "title": "Edit", "options": OPTIONS}
        assert internal(api_client, PERMISSION_URL, body).status_code == 409
        assert agent_messages(dm) == []

    def test_a_person_who_lost_access_stops_it_too(self, api_client, dm, turn, member, workspace):
        _, run_id = turn()
        WorkspaceMember.objects.filter(workspace=workspace, member=member.user).update(is_active=False)
        assert internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "x"}).status_code == 409

    def test_nul_characters_from_the_agent_are_dropped(self, api_client, dm, turn):
        # Postgres stores none: they used to fail the write and leave the draft "writing" for good.
        _, run_id = turn()
        tools = [{"id": "t\u00001", "title": "Read\u0000 WEB-1", "status": "completed"}]
        draft = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "a\u0000b", "tool_calls": tools})
        assert draft.status_code == 200
        final = internal(
            api_client,
            REPLIES_URL,
            {"run_id": run_id, "status": "ok", "text": "done\u0000", "tool_calls": tools, "session_ref": "s\u00001"},
        )
        assert final.status_code == 201
        [reply] = agent_messages(dm)
        assert reply.agent_streaming is False
        assert reply.agent_tool_calls == [{"id": "t1", "title": "Read WEB-1", "status": "completed"}]

    def test_reports_need_the_secret_and_a_valid_body(self, api_client, turn):
        _, run_id = turn()
        assert internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "x"}, secret="wrong").status_code == 403
        assert internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "x"}, secret=None).status_code in (401, 403)
        assert internal(api_client, DRAFT_URL, {"run_id": "nope", "text": "x"}).status_code == 400
        bad_tools = {"run_id": run_id, "text": "x", "tool_calls": [{"id": "t", "title": 3, "status": "x"}]}
        assert internal(api_client, DRAFT_URL, bad_tools).status_code == 400
        bad_final = {"run_id": run_id, "status": "ok", "text": "x", "session_ref": "s" * 300}
        assert internal(api_client, REPLIES_URL, bad_final).status_code == 400

    def test_a_channel_run_has_no_draft(self, api_client, make_channel, member, agent, bridge):
        channel = make_channel(members=[member.user])
        ChannelAgent(channel=channel, agent=agent, permission_level="ask_all").save()
        mention = f'<mention-component entity_name="agent_mention" entity_identifier="{agent.id}"></mention-component>'
        message = Message.objects.create(channel=channel, sender=member.user, body_html=f"<p>{mention} hi</p>")
        with mock.patch.object(agent_replies.requests, "post", bridge):
            agent_replies.respond_to_mentions(str(message.id))
        run_id = bridge.calls[-1]["body"]["run_id"]
        assert internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "x"}).status_code == 404
        body = {"run_id": run_id, "request_id": uuid4().hex, "title": "Edit", "options": OPTIONS}
        assert internal(api_client, PERMISSION_URL, body).status_code == 404


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestEvents:
    def test_responding_draft_updates_final_responded(self, api_client, dm, agent, turn, published, workspace):
        message, run_id = turn()
        ids = {"workspace_id": str(workspace.id), "channel_id": str(dm.id)}
        assert published.events == [
            {"type": "agent.responding", **ids, "message_id": str(message.id), "agent_id": str(agent.id)}
        ]
        draft_id = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "a"}).data["message_id"]
        internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "ab"})
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "abc"})
        assert published.events[1:] == [
            {"type": "message.created", **ids, "message_id": draft_id},
            {"type": "message.updated", **ids, "message_id": draft_id},
            {"type": "message.updated", **ids, "message_id": draft_id},
            {"type": "agent.responded", **ids, "message_id": str(message.id), "agent_id": str(agent.id)},
        ]

    def test_permission_events_name_the_person(self, api_client, dm, agent, member, turn, published, workspace):
        _, run_id = turn()
        request_id = uuid4().hex
        body = {"run_id": run_id, "request_id": request_id, "title": "Edit WEB-1", "options": OPTIONS}
        assert internal(api_client, PERMISSION_URL, body).status_code == 201
        requested = published.events[-1]
        assert requested == {
            "type": "agent.permission_requested",
            "workspace_id": str(workspace.id),
            "channel_id": str(dm.id),
            "user_id": str(member.user.id),
            "agent_id": str(agent.id),
        }
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "done"})
        assert "agent.permission_resolved" in [event["type"] for event in published.events]


# ── approvals ────────────────────────────────────────────────────────────────


@pytest.fixture
def prompt(api_client, turn):
    """A turn whose agent asks for approval; returns (run ID, request ID)."""

    def ask(title="Edit WEB-1"):
        _, run_id = turn()
        request_id = uuid4().hex
        response = internal(
            api_client, PERMISSION_URL, {"run_id": run_id, "request_id": request_id, "title": title, "options": OPTIONS}
        )
        assert response.status_code == 201
        return run_id, request_id

    return ask


@pytest.mark.contract
@pytest.mark.django_db
class TestApprovals:
    def test_the_person_sees_what_is_asked(self, api_client, dm, member, url, prompt):
        run_id, request_id = prompt()
        draft_id = internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "Let me edit it"}).data["message_id"]
        [pending] = member.client.get(url(f"channels/{dm.id}/agent-dm/permissions/")).data
        assert pending["id"] == request_id
        assert pending["title"] == "Edit WEB-1"
        assert pending["options"] == OPTIONS
        assert pending["message_id"] == draft_id

    def test_nobody_else_can_see_or_answer(self, dm, admin, member2, url, prompt, bridge):
        _, request_id = prompt()
        for actor in (admin, member2):
            assert actor.client.get(url(f"channels/{dm.id}/agent-dm/permissions/")).status_code == 404
            answer = actor.client.post(
                url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/"), {"option_id": "allow"}, format="json"
            )
            assert answer.status_code == 404
        assert [call for call in bridge.calls if "/permissions/" in call["url"]] == []

    def test_the_answer_goes_to_the_bridge_once(self, dm, member, url, prompt, bridge):
        run_id, request_id = prompt()
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        response = member.client.post(answer_url, {"option_id": "always"}, format="json")
        assert response.status_code == 200
        assert response.data == {"id": request_id, "status": "answered", "option_id": "always"}
        [call] = [call for call in bridge.calls if "/permissions/" in call["url"]]
        assert call["url"] == f"{BRIDGE}/internal/dm-turns/{dm.id}/permissions/{request_id}"
        assert call["body"] == {"run_id": run_id, "option_id": "always"}
        assert call["headers"]["X-Agent-Bridge-Secret"] == SECRET
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 409
        assert member.client.get(url(f"channels/{dm.id}/agent-dm/permissions/")).data == []

    def test_not_once_the_agent_is_disabled(self, dm, agent, member, url, prompt, bridge):
        # An approval now would run the tool with rights the person no longer has through this agent.
        _, request_id = prompt()
        AgentDefinition.objects.filter(pk=agent.pk).update(is_enabled=False)
        answer = member.client.post(
            url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/"), {"option_id": "allow"}, format="json"
        )
        assert answer.status_code == 409
        assert [call for call in bridge.calls if "/permissions/" in call["url"]] == []

    def test_only_its_own_options(self, dm, member, url, prompt):
        _, request_id = prompt()
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "yolo"}, format="json").status_code == 400
        assert member.client.post(answer_url, {}, format="json").status_code == 400
        unknown = url(f"channels/{dm.id}/agent-dm/permissions/{uuid4().hex}/")
        assert member.client.post(unknown, {"option_id": "allow"}, format="json").status_code == 404

    def test_not_one_from_another_dm(self, member, make_agent, workspace, url, prompt):
        _, request_id = prompt()
        other, _ = Channel.objects.get_or_create_agent_dm(workspace, member.user, make_agent(), "ask_all")
        answer_url = url(f"channels/{other.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 404

    def test_an_expired_request_cant_be_answered(self, dm, member, url, prompt, bridge):
        _, request_id = prompt()
        AgentPermissionRequest.objects.filter(request_id=request_id).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        assert member.client.get(url(f"channels/{dm.id}/agent-dm/permissions/")).data == []
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 409
        assert [call for call in bridge.calls if "/permissions/" in call["url"]] == []

    def test_it_expires_with_the_turn(self, api_client, dm, member, url, prompt):
        run_id, request_id = prompt()
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "failed", "error": "timeout"})
        assert AgentPermissionRequest.objects.get(request_id=request_id).status == AgentPermissionStatus.EXPIRED
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 409

    def test_not_once_another_turn_has_the_dm(self, dm, member, url, prompt, bridge):
        _, request_id = prompt()
        cache.set(turn_lock_key(dm.id), uuid4().hex)
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 409
        assert [call for call in bridge.calls if "/permissions/" in call["url"]] == []

    def test_the_bridge_no_longer_waiting_means_expired(self, dm, member, url, prompt, bridge):
        _, request_id = prompt()
        bridge.statuses["permissions"] = 404
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 409
        assert AgentPermissionRequest.objects.get(request_id=request_id).status == AgentPermissionStatus.EXPIRED

    def test_an_unreachable_bridge_leaves_it_pending(self, dm, member, url, prompt, bridge):
        _, request_id = prompt()
        bridge.error = requests.ConnectionError("down")
        answer_url = url(f"channels/{dm.id}/agent-dm/permissions/{request_id}/")
        assert member.client.post(answer_url, {"option_id": "allow"}, format="json").status_code == 503
        assert AgentPermissionRequest.objects.get(request_id=request_id).status == AgentPermissionStatus.PENDING

    def test_a_disabled_agent_cant_ask(self, api_client, dm, agent, turn):
        _, run_id = turn()
        agent.is_enabled = False
        agent.save()
        body = {"run_id": run_id, "request_id": uuid4().hex, "title": "Edit", "options": OPTIONS}
        assert internal(api_client, PERMISSION_URL, body).status_code == 409

    def test_the_bridge_must_send_options(self, api_client, turn):
        _, run_id = turn()
        body = {"run_id": run_id, "request_id": uuid4().hex, "title": "Edit", "options": []}
        assert internal(api_client, PERMISSION_URL, body).status_code == 400
        body["options"] = OPTIONS
        assert internal(api_client, PERMISSION_URL, body, secret="wrong").status_code == 403


# ── Stop ─────────────────────────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestStop:
    def test_stop_cancels_the_running_turn(self, dm, member, url, turn, bridge):
        _, run_id = turn()
        response = member.client.post(url(f"channels/{dm.id}/agent-dm/stop/"))
        assert response.status_code == 202
        [call] = [call for call in bridge.calls if call["url"].endswith("/cancel")]
        assert call["url"] == f"{BRIDGE}/internal/dm-turns/{dm.id}/cancel"
        assert call["body"] == {"run_id": run_id}

    def test_nothing_to_stop(self, dm, member, url, bridge):
        assert member.client.post(url(f"channels/{dm.id}/agent-dm/stop/")).status_code == 409

    def test_a_turn_the_bridge_forgot_ends_here(self, dm, member, url, turn, bridge):
        turn()
        bridge.statuses["cancel"] = 404
        assert member.client.post(url(f"channels/{dm.id}/agent-dm/stop/")).status_code == 202
        assert agent_messages(dm)[-1].agent_notice == AgentNotice.STOPPED
        assert cache.get(turn_lock_key(dm.id)) is None

    def test_an_unreachable_bridge(self, dm, member, url, turn, bridge):
        turn()
        bridge.error = requests.ConnectionError("down")
        assert member.client.post(url(f"channels/{dm.id}/agent-dm/stop/")).status_code == 503
        assert cache.get(turn_lock_key(dm.id)) is not None

    def test_the_channel_shows_the_turn(self, api_client, dm, member, url, turn):
        _, run_id = turn()
        assert member.client.get(url(f"channels/{dm.id}/")).data["agent_dm"]["responding"] is True
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "done"})
        assert member.client.get(url(f"channels/{dm.id}/")).data["agent_dm"]["responding"] is False


# ── like a DM everywhere else ────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestLikeADm:
    def test_search_finds_it_for_its_person_only(self, api_client, dm, member, admin, url, say, turn):
        say("the zebra release")
        assert member.client.get(url("search/"), {"q": "zebra"}).data["results"][0]["channel"]["agent_dm"] == {
            "agent": mock.ANY
        }
        assert admin.client.get(url("search/"), {"q": "zebra"}).data["results"] == []

    def test_search_skips_a_draft(self, api_client, dm, member, url, turn):
        _, run_id = turn("hi")
        internal(api_client, DRAFT_URL, {"run_id": run_id, "text": "giraffe"})
        assert member.client.get(url("search/"), {"q": "giraffe"}).data["results"] == []
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "giraffe"})
        assert len(member.client.get(url("search/"), {"q": "giraffe"}).data["results"]) == 1

    @pytest.mark.parametrize("include_private", [False, True])
    def test_export_only_with_private_channels_and_dms(self, include_private, dm, say, workspace, admin):
        say("exported?")
        export = MessageExport.objects.create(
            workspace=workspace,
            workspace_slug=workspace.slug,
            include_private=include_private,
            requested_by=admin.user,
            requested_by_email=admin.user.email,
        )
        buffer = io.BytesIO()
        write_archive(buffer, workspace, export)
        with zipfile.ZipFile(buffer) as archive:
            channels = [json.loads(line) for line in archive.read("channels.jsonl").splitlines()]
            members = [json.loads(line) for line in archive.read("members.jsonl").splitlines()]
        exported = [channel for channel in channels if channel["id"] == str(dm.id)]
        if include_private:
            assert exported[0]["kind"] == "agent_dm"
            kinds = {row["member_type"] for row in members if row["channel_id"] == str(dm.id)}
            assert kinds == {"user", "agent"}
        else:
            assert exported == []

    def test_retention_deletes_its_old_messages(self, dm, say, keep_for_days):
        message = say("old news")
        Message.all_objects.filter(pk=message.pk).update(created_at=timezone.now() - timedelta(days=400))
        keep_for_days(30)
        from plane.chat.retention import purge_chat_data

        with mock.patch("plane.chat.retention.S3Storage"):
            purge_chat_data()
        assert not Message.all_objects.filter(pk=message.pk).exists()

    def test_retention_leaves_no_tool_titles_behind(self, api_client, dm, turn, say, keep_for_days):
        message, run_id = turn()
        tools = [{"id": "t1", "title": "Read the salary sheet", "status": "completed"}]
        reply_id = internal(
            api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "x", "tool_calls": tools}
        )
        reply = Message.objects.get(pk=reply_id.data["message_id"])
        # Kept as the start of a thread (a newer reply in it), so emptied rather than deleted.
        say("newer", parent=reply)
        AgentPermissionRequest.objects.create(
            channel=dm,
            run_id=run_id,
            request_id=uuid4().hex,
            title="Read the salary sheet",
            options=OPTIONS,
            expires_at=timezone.now(),
        )
        old = timezone.now() - timedelta(days=400)
        Message.all_objects.filter(pk__in=[message.pk, reply.pk]).update(created_at=old)
        AgentPermissionRequest.objects.update(created_at=old)
        keep_for_days(30)
        from plane.chat.retention import purge_chat_data

        with mock.patch("plane.chat.retention.S3Storage"):
            purge_chat_data()
        reply.refresh_from_db()
        assert reply.removed_at is not None and reply.agent_tool_calls is None
        assert not AgentPermissionRequest.all_objects.exists()

    def test_unread_counts_the_agents_finished_replies(self, api_client, dm, member, url, turn):
        _, run_id = turn()
        internal(api_client, REPLIES_URL, {"run_id": run_id, "status": "ok", "text": "one"})
        channels = {str(channel["id"]): channel for channel in member.client.get(url("channels/")).data}
        assert channels[str(dm.id)]["unread_count"] == 1


@pytest.fixture
def keep_for_days(db):
    from plane.chat.retention import RETENTION_KEY
    from plane.license.models import InstanceConfiguration

    def keep(days):
        InstanceConfiguration.objects.update_or_create(key=RETENTION_KEY, defaults={"value": str(days)})

    return keep


def test_the_worker_imports_the_turn_tasks(settings):
    """The worker only knows tasks from the modules `CELERY_IMPORTS` names."""
    assert "plane.chat.agent_dm" in settings.CELERY_IMPORTS
    assert respond_in_agent_dm.name == "plane.chat.agent_dm.respond_in_agent_dm"
    assert start_queued_dm_turn.name == "plane.chat.agent_dm.start_queued_dm_turn"
