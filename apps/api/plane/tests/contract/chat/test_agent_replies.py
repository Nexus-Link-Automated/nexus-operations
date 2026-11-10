# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""@mentioning an agent in a channel: what sets it off, what it is shown, and how its reply is posted.

The agent bridge is replaced by a stub of its internal endpoint; the bridge's own tests cover the session.
"""

import json
import time
from unittest import mock
from uuid import uuid4

import pytest
import requests
from bs4 import BeautifulSoup
from django.core.cache import cache
from django.utils import timezone

from plane.chat import agent_replies
from plane.chat.agent_replies import (
    MAX_AGENTS_PER_MESSAGE,
    MAX_CONTEXT_CHARS,
    MAX_MENTION_CHARS,
    build_prompt,
    finish_run,
    respond_to_mentions,
    start_run,
    thread_lock_key,
)
from plane.chat.markdown import markdown_to_html
from plane.chat.models import AgentNotice, ChannelAgent, ChannelKind, ChannelMember, Message
from plane.chat.notifications import CHAT_MESSAGE_ENTITY
from plane.db.models import Notification
from plane.license.models import AgentDefinition

from .conftest import GUEST

BRIDGE = "http://agent-bridge.test:3400"
SECRET = "bridge-secret-for-tests"
REPLIES_URL = "/api/internal/chat/agent-replies/"


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
    """`requests.post` to the bridge: records each session asked for and answers `status`."""

    def __init__(self):
        self.calls = []
        self.status = 202
        self.error = None

    def __call__(self, url, data=None, headers=None, **kwargs):
        if self.error:
            raise self.error
        self.calls.append({"url": url, "headers": headers, "body": json.loads(data), **kwargs})
        response = mock.Mock()
        response.status_code = self.status
        return response

    @property
    def runs(self):
        return [call["body"] for call in self.calls]


@pytest.fixture
def bridge(expiry):
    stub = StubBridge()
    with mock.patch.object(agent_replies.requests, "post", stub):
        yield stub


@pytest.fixture
def expiry():
    """The task queued to note a run the bridge never reports on; kept off the broker."""
    with mock.patch.object(agent_replies.expire_run, "apply_async") as queued:
        yield queued


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
    return make_agent()


def seat(channel, agent, level="ask_writes"):
    row = ChannelAgent(channel=channel, agent=agent, permission_level=level)
    row.save()
    return row


def mention(agent_or_id, entity="agent_mention"):
    identifier = getattr(agent_or_id, "pk", agent_or_id)
    return f'<mention-component entity_name="{entity}" entity_identifier="{identifier}"></mention-component>'


def user_mention(user):
    return mention(user.pk, "user_mention")


@pytest.fixture
def channel(make_channel, member, member2, agent):
    channel = make_channel(members=[member.user, member2.user])
    seat(channel, agent)
    return channel


@pytest.fixture
def ask(channel, member, agent):
    """ask(text, ...) -> a message by `member` mentioning `agent` (or `agents`), saved as the API would."""

    def ask(text="what's left?", by=None, in_channel=None, parent=None, agents=None):
        mentions = " ".join(mention(a) for a in (agents or [agent]))
        return Message.objects.create(
            channel=in_channel or channel,
            sender=(by or member).user,
            parent=parent,
            body_html=f"<p>{mentions} {text}</p>",
        )

    return ask


def internal(client, body, secret=SECRET):
    headers = {"HTTP_X_AGENT_BRIDGE_SECRET": secret} if secret is not None else {}
    return client.post(REPLIES_URL, body, format="json", **headers)


def replies_in(thread_root):
    """The agents' messages in the thread."""
    return list(Message.objects.filter(parent=thread_root, sender_agent__isnull=False).order_by("created_at"))


# ── what sets an agent off ───────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestTrigger:
    def test_a_new_message_queues_the_worker_after_commit(
        self, member, channel, agent, url, django_capture_on_commit_callbacks
    ):
        with mock.patch.object(agent_replies.respond_to_mentions, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                response = member.client.post(
                    url(f"channels/{channel.id}/messages/"), {"body_html": f"<p>{mention(agent)} hi</p>"}, format="json"
                )
        assert response.status_code == 201, response.data
        delay.assert_called_once_with(str(response.data["id"]), [str(agent.id)])

    def test_a_reply_queues_the_worker_too(self, member, channel, agent, url, send, django_capture_on_commit_callbacks):
        root = send(channel, member.user)
        with mock.patch.object(agent_replies.respond_to_mentions, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                response = member.client.post(
                    url(f"channels/{channel.id}/messages/"),
                    {"body_html": f"<p>{mention(agent)} hi</p>", "parent_id": str(root.id)},
                    format="json",
                )
        delay.assert_called_once_with(str(response.data["id"]), [str(agent.id)])

    def test_editing_a_mention_in_starts_nothing(
        self, member, channel, agent, url, send, django_capture_on_commit_callbacks
    ):
        message = send(channel, member.user, "hi")
        with mock.patch.object(agent_replies.respond_to_mentions, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                response = member.client.patch(
                    url(f"channels/{channel.id}/messages/{message.id}/"),
                    {"body_html": f"<p>{mention(agent)} hi</p>"},
                    format="json",
                )
        assert response.status_code == 200
        assert not delay.called

    def test_an_edit_before_the_worker_runs_can_take_a_mention_back_but_not_add_one(
        self, ask, bridge, make_agent, channel, agent
    ):
        other = make_agent(name="Other")
        seat(channel, other)
        message = ask()
        sent_with = [str(agent.id)]
        Message.objects.filter(pk=message.pk).update(body_html=f"<p>{mention(other)} instead</p>")
        respond_to_mentions(str(message.id), sent_with)
        assert bridge.calls == []
        Message.objects.filter(pk=message.pk).update(body_html=f"<p>{mention(agent)} {mention(other)} both</p>")
        respond_to_mentions(str(message.id), sent_with)
        assert [run["agent_id"] for run in bridge.runs] == [str(agent.id)]

    def test_a_broker_outage_does_not_fail_the_send(
        self, member, channel, agent, url, django_capture_on_commit_callbacks
    ):
        with mock.patch.object(agent_replies.respond_to_mentions, "delay", side_effect=OSError("broker down")):
            with django_capture_on_commit_callbacks(execute=True):
                response = member.client.post(
                    url(f"channels/{channel.id}/messages/"), {"body_html": f"<p>{mention(agent)} hi</p>"}, format="json"
                )
        assert response.status_code == 201

    def test_a_mention_starts_a_session_as_the_person_who_asked(self, ask, bridge, member, agent, workspace):
        message = ask()
        respond_to_mentions(str(message.id))
        [call] = bridge.calls
        assert call["url"] == f"{BRIDGE}/internal/channel-sessions"
        assert call["headers"]["X-Agent-Bridge-Secret"] == SECRET
        assert call["allow_redirects"] is False
        run = call["body"]
        assert run["user_id"] == str(member.user.id)
        assert run["workspace_slug"] == workspace.slug
        assert run["agent_id"] == str(agent.id)
        assert run["permission_level"] == "ask_writes"
        assert run["timeout_ms"] == 300_000
        assert "what's left?" in run["prompt"]
        # Running: the thread is held, and the run is waiting for the bridge.
        assert cache.get(thread_lock_key(agent.id, message.id)) == run["run_id"]

    def test_the_level_is_the_channels_clamped_to_the_registry(self, ask, bridge, agent, channel):
        ChannelAgent.objects.filter(channel=channel, agent=agent).update(permission_level="ask_writes")
        AgentDefinition.objects.filter(pk=agent.pk).update(max_permission_level="ask_all")
        respond_to_mentions(str(ask().id))
        assert bridge.runs[0]["permission_level"] == "ask_all"

    def test_a_channel_agent_never_works_without_asking_for_writes(self, ask, bridge, agent, channel):
        # Nobody can answer its prompts in a channel, and other members' messages are in what it reads.
        AgentDefinition.objects.filter(pk=agent.pk).update(max_permission_level="yolo")
        ChannelAgent.objects.filter(channel=channel, agent=agent).update(permission_level="yolo")
        respond_to_mentions(str(ask().id))
        assert bridge.runs[0]["permission_level"] == "ask_writes"

    def test_a_workspace_admin_in_the_channel_can_set_it_off(self, ask, bridge, admin, channel):
        ChannelMember.objects.create(channel=channel, user=admin.user)
        respond_to_mentions(str(ask(by=admin).id))
        assert len(bridge.calls) == 1

    def test_each_agent_mentioned_once(self, ask, bridge, make_agent, channel, agent):
        others = [make_agent(name=f"A{i}") for i in range(MAX_AGENTS_PER_MESSAGE + 1)]
        for other in others:
            seat(channel, other)
        respond_to_mentions(str(ask(agents=[agent, agent, *others]).id))
        started = [run["agent_id"] for run in bridge.runs]
        assert started == [str(agent.id)] + [str(a.id) for a in others[: MAX_AGENTS_PER_MESSAGE - 1]]

    def test_a_guest_never_sets_an_agent_off(self, make_actor, ask, bridge, channel):
        guest = make_actor(GUEST)
        ChannelMember.objects.create(channel=channel, user=guest.user)
        respond_to_mentions(str(ask(by=guest).id))
        assert bridge.calls == []
        assert Message.objects.filter(sender_agent__isnull=False).count() == 0

    def test_someone_not_in_the_channel_never_sets_an_agent_off(self, ask, bridge, member, channel):
        message = ask()
        ChannelMember.objects.filter(channel=channel, user=member.user).delete()
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_someone_who_left_the_workspace_never_sets_an_agent_off(self, ask, bridge, member, workspace):
        message = ask()
        member.user.member_workspace.filter(workspace=workspace).update(is_active=False)
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_an_agent_mentioning_an_agent_starts_nothing(
        self, channel, agent, make_agent, bridge, django_capture_on_commit_callbacks
    ):
        other = make_agent(name="Other")
        seat(channel, other)
        message = Message.objects.create(channel=channel, sender_agent=other.slug, body_html=f"<p>{mention(agent)}</p>")
        with mock.patch.object(agent_replies.respond_to_mentions, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True) as callbacks:
                agent_replies.queue_agent_replies(message)
        assert callbacks == []
        assert not delay.called
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_an_automatic_message_starts_nothing(self, channel, agent, bridge):
        message = Message.objects.create(
            channel=channel, system_event="work_item_state", body_html=f"<p>{mention(agent)}</p>"
        )
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_a_disabled_agent_is_not_set_off(self, ask, bridge, agent):
        message = ask()
        AgentDefinition.objects.filter(pk=agent.pk).update(is_enabled=False)
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_an_agent_removed_from_the_channel_is_not_set_off(self, ask, bridge, agent, channel):
        message = ask()
        ChannelAgent.objects.get(channel=channel, agent=agent).delete()
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_an_agent_deleted_from_the_registry_is_not_set_off(self, ask, bridge, agent):
        message = ask()
        AgentDefinition.objects.filter(pk=agent.pk).update(deleted_at=timezone.now())
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_an_agent_not_in_the_channel_is_not_set_off(self, ask, bridge, make_agent, make_channel, member):
        elsewhere = make_agent(name="Elsewhere")
        # In another channel of the workspace, not this one.
        seat(make_channel(members=[member.user]), elsewhere)
        respond_to_mentions(str(ask(agents=[elsewhere]).id))
        assert bridge.calls == []

    def test_an_archived_channel_sets_nothing_off(self, ask, bridge, channel):
        message = ask()
        channel.archived_at = timezone.now()
        channel.save(update_fields=["archived_at"])
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_a_deleted_channel_sets_nothing_off(self, ask, bridge, channel):
        message = ask()
        type(channel).objects.filter(pk=channel.pk).update(deleted_at=timezone.now())
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_a_removed_message_sets_nothing_off(self, ask, bridge):
        message = ask()
        message.remove()
        respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_a_user_mention_or_a_bad_id_is_not_an_agent_mention(self, member, channel, agent, bridge):
        for body in (user_mention(agent), mention("not-a-uuid"), '<mention-component entity_name="agent_mention">'):
            message = Message.objects.create(channel=channel, sender=member.user, body_html=f"<p>{body}</p>")
            respond_to_mentions(str(message.id))
        assert bridge.calls == []

    def test_a_user_mention_of_an_agents_id_is_not_an_agent_mention(self, member, channel, agent, make_agent, bridge):
        # Beside a real agent mention, of an agent not in the channel.
        body = f"<p>{user_mention(agent)} {mention(make_agent(name='Elsewhere'))}</p>"
        respond_to_mentions(str(Message.objects.create(channel=channel, sender=member.user, body_html=body).id))
        assert bridge.calls == []

    def test_an_agent_mention_is_not_a_user_mention(self, ask, member2):
        # The inbox only ever reads user mentions.
        ask()
        assert not Notification.objects.filter(entity_name=CHAT_MESSAGE_ENTITY).exists()


# ── what the agent is shown ──────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestPrompt:
    def test_a_top_level_mention_shows_the_channels_last_top_level_messages(self, channel, member2, send, ask, agent):
        old = [send(channel, member2.user, f"old {i}") for i in range(25)]
        root = old[-1]
        send(channel, member2.user, "a reply nobody needs", parent=root)
        prompt = build_prompt(ask("summarise please"), agent.id)
        assert "summarise please" in prompt
        assert "old 24" in prompt and "old 5" in prompt
        # Twenty top-level messages, not the oldest ones, and no thread replies.
        assert "old 4\n" not in prompt and "old 0\n" not in prompt
        assert "a reply nobody needs" not in prompt

    def test_a_reply_shows_its_thread_only(self, channel, member2, send, ask, agent):
        root = send(channel, member2.user, "the root")
        send(channel, member2.user, "in the thread", parent=root)
        other = send(channel, member2.user, "another conversation")
        send(channel, member2.user, "another thread", parent=other)
        prompt = build_prompt(ask("and you?", parent=root), agent.id)
        assert "the root" in prompt and "in the thread" in prompt and "and you?" in prompt
        assert "another conversation" not in prompt and "another thread" not in prompt
        assert "earlier in this thread" in prompt

    def test_removed_messages_are_left_out(self, channel, member2, send, ask, agent):
        member2.user.display_name = "Grace"
        member2.user.save()
        gone = send(channel, member2.user, "secret plans")
        gone.remove()
        prompt = build_prompt(ask(), agent.id)
        assert "secret plans" not in prompt
        # Not even as an empty message.
        assert "--- Grace" not in prompt

    def test_nothing_from_other_channels(self, channel, make_channel, member, member2, send, ask, agent):
        other = make_channel(ChannelKind.PRIVATE, members=[member.user, member2.user])
        seat(other, agent)
        send(other, member2.user, "private matters")
        send(channel, member2.user, "public matters")
        prompt = build_prompt(ask(), agent.id)
        assert "public matters" in prompt and "private matters" not in prompt

    def test_a_private_channel_says_so(self, make_channel, member, agent, ask):
        private = make_channel(ChannelKind.PRIVATE, name="secret-room", members=[member.user])
        seat(private, agent)
        prompt = build_prompt(ask(in_channel=private), agent.id)
        assert "#secret-room (a private channel)" in prompt

    def test_people_and_agents_are_named(self, channel, member, member2, make_agent, ask, agent):
        member.user.display_name = "Ada"
        member.user.save()
        member2.user.display_name = "Grace"
        member2.user.save()
        other = make_agent(name="Scout")
        Message.objects.create(channel=channel, sender_agent=other.slug, body_html="<p>Found it</p>")
        Message.objects.create(channel=channel, sender=member2.user, body_html=f"<p>thanks {mention(other)}</p>")
        prompt = build_prompt(ask(f"ask {user_mention(member2.user)}"), agent.id)
        assert "--- Scout, " in prompt and "Found it" in prompt
        assert "--- Grace, " in prompt and "thanks @Scout" in prompt
        assert "Ada mentioned you in" in prompt
        assert "@Maia ask @Grace" in prompt
        assert str(member2.user.id) not in prompt

    def test_someone_outside_the_workspace_is_not_named(self, ask, agent, outsider):
        outsider.user.display_name = "Mallory"
        outsider.user.save()
        prompt = build_prompt(ask(f"ask {user_mention(outsider.user)}"), agent.id)
        assert "Mallory" not in prompt

    def test_size_is_bounded(self, channel, member2, send, ask, agent):
        for i in range(30):
            send(channel, member2.user, f"{i} " + "x" * 5_000)
        prompt = build_prompt(ask("y" * 20_000), agent.id)
        assert len(prompt) < MAX_CONTEXT_CHARS + MAX_MENTION_CHARS + 2_000
        # The newest messages are the ones kept.
        assert "\n29 xxx" in prompt

    def test_nothing_is_read_once_the_agent_leaves_or_is_disabled(self, channel, ask, agent):
        message = ask()
        AgentDefinition.objects.filter(pk=agent.pk).update(is_enabled=False)
        assert build_prompt(message, agent.id) is None
        AgentDefinition.objects.filter(pk=agent.pk).update(is_enabled=True)
        ChannelAgent.objects.get(channel=channel, agent=agent).delete()
        assert build_prompt(message, agent.id) is None


# ── the bridge's report ──────────────────────────────────────────────────────


@pytest.fixture
def run(ask, bridge):
    """A mention whose session the bridge accepted: (message, run_id)."""
    message = ask()
    respond_to_mentions(str(message.id))
    return message, bridge.runs[-1]["run_id"]


@pytest.mark.contract
@pytest.mark.django_db
class TestReplyEndpoint:
    def test_the_secret_is_required(self, api_client, run, settings):
        message, run_id = run
        body = {"run_id": run_id, "status": "ok", "text": "hi"}
        assert internal(api_client, body, secret=None).status_code == 403
        assert internal(api_client, body, secret="wrong").status_code == 403
        settings.AGENT_BRIDGE_SECRET = ""
        assert internal(api_client, body, secret="").status_code == 403
        assert replies_in(message) == []

    def test_a_session_cookie_is_not_enough(self, member, run):
        _, run_id = run
        assert internal(member.client, {"run_id": run_id, "status": "ok", "text": "hi"}, secret=None).status_code == 403

    def test_the_reply_is_posted_in_the_thread_as_the_agent(self, api_client, run, agent, member):
        message, run_id = run
        response = internal(api_client, {"run_id": run_id, "status": "ok", "text": "**Two** items left."})
        assert response.status_code == 201, response.data
        [reply] = replies_in(message)
        assert str(reply.id) == response.data["message_id"]
        assert reply.sender is None and reply.sender_agent == agent.slug
        assert reply.agent_notice is None
        assert "<strong>Two</strong> items left." in reply.body_html
        # It mentions whoever asked, so it reaches their inbox.
        assert f'entity_identifier="{member.user.id}"' in reply.body_html
        entry = Notification.objects.get(entity_identifier=reply.id, receiver=member.user)
        assert entry.title == "Maia mentioned you in a message"
        # The thread is free again, and the run can't be used twice.
        assert cache.get(thread_lock_key(agent.id, message.id)) is None
        again = internal(api_client, {"run_id": run_id, "status": "ok", "text": "again"})
        assert again.status_code == 404
        assert len(replies_in(message)) == 1

    def test_a_reply_to_a_thread_reply_goes_in_the_same_thread(self, api_client, ask, bridge, send, channel, member2):
        root = send(channel, member2.user, "root")
        asked = ask(parent=root)
        respond_to_mentions(str(asked.id))
        response = internal(api_client, {"run_id": bridge.runs[-1]["run_id"], "status": "ok", "text": "done"})
        assert response.status_code == 201
        assert Message.objects.get(pk=response.data["message_id"]).parent_id == root.id

    @pytest.mark.parametrize(
        "body",
        [
            {"status": "ok", "text": "hi"},
            {"run_id": "nope", "status": "ok", "text": "hi"},
            {"run_id": "a" * 32, "status": "maybe"},
            {"run_id": "a" * 32, "status": "ok", "text": 5},
            {"run_id": "a" * 32, "status": "ok", "text": "hi", "permission_requests": "edit"},
            {"run_id": "a" * 32, "status": "ok", "text": "hi", "permission_requests": [1]},
        ],
    )
    def test_bad_bodies_are_refused(self, api_client, body):
        assert internal(api_client, body).status_code == 400

    def test_an_unknown_run_is_refused(self, api_client, run):
        assert internal(api_client, {"run_id": uuid4().hex, "status": "ok", "text": "hi"}).status_code == 404

    def _refused(self, api_client, run, change):
        message, run_id = run
        change(message)
        response = internal(api_client, {"run_id": run_id, "status": "ok", "text": "hi"})
        assert response.status_code == 409, response.data
        assert Message.objects.filter(sender_agent__isnull=False).count() == 0
        return response

    def test_refused_once_the_agent_leaves_the_channel(self, api_client, run, agent):
        self._refused(api_client, run, lambda m: ChannelAgent.objects.get(channel=m.channel, agent=agent).delete())

    def test_refused_once_the_agent_is_disabled(self, api_client, run, agent):
        self._refused(api_client, run, lambda m: AgentDefinition.objects.filter(pk=agent.pk).update(is_enabled=False))

    def test_refused_once_the_channel_is_archived(self, api_client, run):
        def archive(message):
            message.channel.archived_at = timezone.now()
            message.channel.save(update_fields=["archived_at"])

        self._refused(api_client, run, archive)

    def test_refused_once_the_channel_is_deleted(self, api_client, run):
        self._refused(
            api_client,
            run,
            lambda m: type(m.channel).objects.filter(pk=m.channel_id).update(deleted_at=timezone.now()),
        )

    def test_refused_once_the_mention_is_deleted(self, api_client, run):
        response = self._refused(api_client, run, lambda m: m.remove())
        assert response.data["error"] == "message_removed"

    def test_not_posted_once_the_asker_has_left_the_channel(self, api_client, run, member):
        # Worked out with their rights: not for a channel they are no longer in.
        message, run_id = run
        ChannelMember.objects.filter(channel=message.channel, user=member.user).delete()
        response = internal(api_client, {"run_id": run_id, "status": "ok", "text": "your private items: ..."})
        assert response.status_code == 409 and response.data["error"] == "asker_gone"
        assert replies_in(message) == []

    def test_a_refusal_still_frees_the_thread(self, api_client, run, agent):
        message, run_id = run
        message.remove()
        internal(api_client, {"run_id": run_id, "status": "ok", "text": "hi"})
        assert cache.get(thread_lock_key(agent.id, message.id)) is None

    @pytest.mark.parametrize(
        "hostile",
        [
            "<script>alert(1)</script>",
            '<img src=x onerror="alert(1)">',
            "[click](javascript:alert(1))",
            '"><svg onload=alert(1)>',
            '<mention-component entity_name="agent_mention" entity_identifier="x"></mention-component>',
            '<a href="javascript:alert(1)">x</a>',
            "`<script>` and ```\n<iframe src=x></iframe>\n```",
        ],
    )
    def test_hostile_markdown_stays_text(self, api_client, ask, bridge, hostile):
        message = ask()
        respond_to_mentions(str(message.id))
        response = internal(api_client, {"run_id": bridge.runs[-1]["run_id"], "status": "ok", "text": hostile})
        assert response.status_code == 201
        body = Message.objects.get(pk=response.data["message_id"]).body_html
        tags = BeautifulSoup(body, "html.parser").find_all(True)
        assert {tag.name for tag in tags} <= {"p", "br", "code", "pre", "a", "mention-component"}, body
        for tag in tags:
            assert not [name for name in tag.attrs if name.lower().startswith("on")], body
            assert tag.get("entity_name") in (None, "user_mention"), body
            assert not tag.get("href") or tag["href"].startswith(("http://", "https://", "mailto:")), body
        # The agent's text is still there, as text.
        assert "&lt;" in body or "click" in body

    def test_markdown_becomes_the_composers_html(self, api_client, run):
        message, run_id = run
        text = "# Plan\n\n- first `step`\n- second\n\n1. one\n2. two\n\n> quoted\n\n```\ncode <b>\n```\n\nsee [docs](https://example.com/a?b=1&c=2)"
        response = internal(api_client, {"run_id": run_id, "status": "ok", "text": text})
        body = Message.objects.get(pk=response.data["message_id"]).body_html
        assert "<strong>Plan</strong>" in body
        assert "<ul><li><p>first <code>step</code></p></li><li><p>second</p></li></ul>" in body
        assert "<ol><li><p>one</p></li><li><p>two</p></li></ol>" in body
        assert "<blockquote><p>quoted</p></blockquote>" in body
        assert "<pre><code>code &lt;b&gt;</code></pre>" in body
        assert 'href="https://example.com/a?b=1&amp;c=2"' in body

    def test_a_link_to_anything_but_the_web_or_email_is_text(self, api_client, run):
        message, run_id = run
        text = "[run me](javascript:alert(1)) [file](file:///etc/passwd) [mail](mailto:ada@example.com)"
        response = internal(api_client, {"run_id": run_id, "status": "ok", "text": text})
        links = BeautifulSoup(Message.objects.get(pk=response.data["message_id"]).body_html, "html.parser").find_all(
            "a"
        )
        assert [(link.get_text(), link.get("href")) for link in links] == [("mail", "mailto:ada@example.com")]

    def test_a_long_reply_is_cut(self, api_client, run):
        message, run_id = run
        response = internal(api_client, {"run_id": run_id, "status": "ok", "text": "word " * 20_000})
        reply = Message.objects.get(pk=response.data["message_id"])
        assert len(reply.body_stripped) < agent_replies.MAX_REPLY_CHARS + 100
        assert reply.body_stripped.endswith("…")

    def test_refused_permission_prompts_are_named(self, api_client, run):
        message, run_id = run
        response = internal(
            api_client,
            {
                "run_id": run_id,
                "status": "ok",
                "text": "I couldn't finish.",
                "permission_requests": [
                    "edit work item WEB-12",
                    "edit work item WEB-12",
                    "run <b>tests</b>",
                    "Delete the release page",
                    "WEB-7",
                ],
            },
        )
        body = Message.objects.get(pk=response.data["message_id"]).body_html
        assert (
            body.count("I needed permission to edit work item WEB-12, which can't be granted from Messages yet.") == 1
        )
        assert "run &lt;b&gt;tests&lt;/b&gt;" in body
        assert "I needed permission to delete the release page" in body
        assert "I needed permission to WEB-7" in body

    @pytest.mark.parametrize(
        "error, notice",
        [
            ("timeout", AgentNotice.TIMEOUT),
            ("unavailable", AgentNotice.UNAVAILABLE),
            ("busy", AgentNotice.UNAVAILABLE),
            ("credentials", AgentNotice.CREDENTIALS),
            ("failed", AgentNotice.FAILED),
            ("something new", AgentNotice.FAILED),
        ],
    )
    def test_a_failure_posts_a_note(self, api_client, run, error, notice):
        message, run_id = run
        response = internal(api_client, {"run_id": run_id, "status": "failed", "error": error})
        assert response.status_code == 201
        [reply] = replies_in(message)
        assert reply.agent_notice == notice
        assert agent_replies.NOTICE_TEXT[notice].split(":")[0] in reply.body_stripped

    def test_an_empty_answer_posts_a_note(self, api_client, run):
        message, run_id = run
        internal(api_client, {"run_id": run_id, "status": "ok", "text": "  "})
        assert replies_in(message)[0].agent_notice == AgentNotice.EMPTY

    def test_the_notice_is_in_the_api(self, api_client, run, member, url):
        message, run_id = run
        internal(api_client, {"run_id": run_id, "status": "failed", "error": "timeout"})
        response = member.client.get(url(f"channels/{message.channel_id}/messages/{message.id}/replies/"))
        assert response.data["results"][0]["agent_notice"] == "timeout"
        assert response.data["results"][0]["sender_agent_details"]["name"] == "Maia"

    def test_only_an_agent_message_can_carry_a_notice(self, channel, member):
        from django.db import IntegrityError, transaction

        with pytest.raises(IntegrityError), transaction.atomic():
            Message.objects.create(channel=channel, sender=member.user, body_html="<p>x</p>", agent_notice="timeout")


# ── limits and failures ──────────────────────────────────────────────────────


@pytest.mark.contract
@pytest.mark.django_db
class TestLimits:
    def test_one_session_per_agent_per_thread(self, ask, bridge, agent):
        first = ask()
        respond_to_mentions(str(first.id))
        second = ask("and another thing", parent=first)
        respond_to_mentions(str(second.id))
        assert len(bridge.calls) == 1
        [note] = replies_in(first)
        assert note.agent_notice == AgentNotice.STILL_WORKING
        assert note.sender_agent == agent.slug

    def test_other_threads_and_agents_are_not_held_up(self, ask, bridge, make_agent, channel):
        other = make_agent(name="Other")
        seat(channel, other)
        first = ask()
        respond_to_mentions(str(first.id))
        respond_to_mentions(str(ask().id))
        respond_to_mentions(str(ask(agents=[other], parent=first).id))
        assert len(bridge.calls) == 3

    def test_the_thread_is_free_again_after_the_reply(self, api_client, ask, bridge):
        first = ask()
        respond_to_mentions(str(first.id))
        internal(api_client, {"run_id": bridge.runs[-1]["run_id"], "status": "ok", "text": "done"})
        respond_to_mentions(str(ask(parent=first).id))
        assert len(bridge.calls) == 2

    def test_sessions_per_person(self, settings, ask, bridge, member2, channel, agent):
        settings.CHAT_RATE_LIMITS = {**settings.CHAT_RATE_LIMITS, "agent_session": "2/hour"}
        messages = [ask() for _ in range(3)]
        for message in messages:
            respond_to_mentions(str(message.id))
        assert len(bridge.calls) == 2
        assert replies_in(messages[2])[0].agent_notice == AgentNotice.RATE_LIMITED
        # Someone else still can.
        respond_to_mentions(str(ask(by=member2).id))
        assert len(bridge.calls) == 3

    def test_sessions_per_agent_per_channel(self, settings, ask, bridge, member2, make_channel, member, agent):
        settings.CHAT_RATE_LIMITS = {**settings.CHAT_RATE_LIMITS, "agent_channel": "1/hour"}
        respond_to_mentions(str(ask().id))
        refused = ask(by=member2)
        respond_to_mentions(str(refused.id))
        assert len(bridge.calls) == 1
        assert replies_in(refused)[0].agent_notice == AgentNotice.RATE_LIMITED
        elsewhere = make_channel(members=[member.user])
        seat(elsewhere, agent)
        respond_to_mentions(str(ask(in_channel=elsewhere).id))
        assert len(bridge.calls) == 2

    def test_posts_per_agent(self, settings, api_client, ask, bridge):
        settings.CHAT_RATE_LIMITS = {**settings.CHAT_RATE_LIMITS, "agent_post": "1/hour"}
        first, second = ask(), ask()
        respond_to_mentions(str(first.id))
        respond_to_mentions(str(second.id))
        runs = [run["run_id"] for run in bridge.runs]
        assert internal(api_client, {"run_id": runs[0], "status": "ok", "text": "one"}).status_code == 201
        response = internal(api_client, {"run_id": runs[1], "status": "ok", "text": "two"})
        assert response.status_code == 429
        assert replies_in(second) == []

    def test_asking_again_and_again_posts_one_note_a_minute_and_spends_no_reply_budget(
        self, settings, api_client, ask, bridge
    ):
        settings.CHAT_RATE_LIMITS = {**settings.CHAT_RATE_LIMITS, "agent_post": "1/hour"}
        first = ask()
        respond_to_mentions(str(first.id))
        for _ in range(5):
            respond_to_mentions(str(ask("again?", parent=first).id))
        assert [reply.agent_notice for reply in replies_in(first)] == [AgentNotice.STILL_WORKING]
        # The answer itself still has its budget.
        response = internal(api_client, {"run_id": bridge.runs[0]["run_id"], "status": "ok", "text": "done"})
        assert response.status_code == 201

    def test_the_lock_expires_with_the_timeout(self, ask, bridge, agent, settings):
        settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS = 30
        message = ask()
        respond_to_mentions(str(message.id))
        ttl = cache.ttl(thread_lock_key(agent.id, message.id))
        assert 30 < ttl <= 30 + agent_replies.RUN_GRACE_SECONDS


@pytest.mark.contract
@pytest.mark.django_db
class TestBridgeFailures:
    def _note(self, ask, agent):
        message = ask()
        respond_to_mentions(str(message.id))
        [note] = replies_in(message)
        assert note.sender_agent == agent.slug
        assert note.agent_notice == AgentNotice.UNAVAILABLE
        assert cache.get(thread_lock_key(agent.id, message.id)) is None
        return note

    def test_bridge_down(self, ask, bridge, agent):
        bridge.error = requests.ConnectionError("refused")
        self._note(ask, agent)

    def test_bridge_at_capacity(self, ask, bridge, agent):
        bridge.status = 429
        self._note(ask, agent)

    def test_bridge_refuses(self, ask, bridge, agent):
        bridge.status = 403
        self._note(ask, agent)

    def test_not_configured(self, ask, bridge, agent, settings):
        settings.AGENT_BRIDGE_INTERNAL_URL = ""
        self._note(ask, agent)
        assert bridge.calls == []

    def test_a_run_the_bridge_never_reports_on_gets_a_note_when_its_time_is_up(self, ask, bridge, expiry, agent):
        message = ask()
        respond_to_mentions(str(message.id))
        run_id = bridge.runs[-1]["run_id"]
        expiry.assert_called_once_with((run_id,), countdown=300 + agent_replies.RUN_GRACE_SECONDS)
        agent_replies.expire_run(run_id)
        [note] = replies_in(message)
        assert note.agent_notice == AgentNotice.FAILED
        assert cache.get(thread_lock_key(agent.id, message.id)) is None

    def test_the_expiry_leaves_a_finished_run_alone(self, api_client, ask, bridge):
        message = ask()
        respond_to_mentions(str(message.id))
        run_id = bridge.runs[-1]["run_id"]
        internal(api_client, {"run_id": run_id, "status": "ok", "text": "done"})
        agent_replies.expire_run(run_id)
        assert [reply.agent_notice for reply in replies_in(message)] == [None]

    def test_an_error_while_starting_frees_the_thread_and_says_so(self, ask, bridge, agent):
        message = ask()
        with mock.patch.object(agent_replies, "build_prompt", side_effect=RuntimeError("database went away")):
            respond_to_mentions(str(message.id))
        assert bridge.calls == []
        assert [reply.agent_notice for reply in replies_in(message)] == [AgentNotice.FAILED]
        assert cache.get(thread_lock_key(agent.id, message.id)) is None

    def test_no_expiry_for_a_run_that_never_started(self, ask, bridge, expiry):
        bridge.status = 503
        respond_to_mentions(str(ask().id))
        assert not expiry.called

    def test_a_run_finishes_once(self, ask, bridge):
        message = ask()
        respond_to_mentions(str(message.id))
        run_id = bridge.runs[-1]["run_id"]
        assert finish_run(run_id, {"status": "ok", "text": "a"})[0] is not None
        assert finish_run(run_id, {"status": "ok", "text": "b"}) == (None, "unknown")

    def test_start_run_on_an_agent_gone_meanwhile_posts_nothing(self, ask, bridge, agent, channel):
        message = ask()
        channel_agent = ChannelAgent.objects.get(channel=channel, agent=agent)
        channel_agent.delete()
        assert start_run(message, channel_agent) is None
        assert bridge.calls == []
        assert replies_in(message) == []
        assert cache.get(thread_lock_key(agent.id, message.id)) is None


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestEvents:
    def test_responding_then_the_reply_then_responded(
        self, api_client, ask, bridge, published, agent, channel, workspace
    ):
        message = ask()
        respond_to_mentions(str(message.id))
        ids = {
            "workspace_id": str(workspace.id),
            "channel_id": str(channel.id),
            "message_id": str(message.id),
            "parent_id": str(message.id),
            "agent_id": str(agent.id),
        }
        assert published.events == [{"type": "agent.responding", **ids}]
        response = internal(api_client, {"run_id": bridge.runs[-1]["run_id"], "status": "ok", "text": "hi"})
        assert published.events[1:] == [
            {
                "type": "message.created",
                "workspace_id": str(workspace.id),
                "channel_id": str(channel.id),
                "message_id": response.data["message_id"],
                "parent_id": str(message.id),
            },
            {"type": "agent.responded", **ids},
        ]

    def test_responded_even_when_nothing_is_posted(self, api_client, ask, bridge, published):
        message = ask()
        respond_to_mentions(str(message.id))
        message.remove()
        internal(api_client, {"run_id": bridge.runs[-1]["run_id"], "status": "ok", "text": "hi"})
        assert [event["type"] for event in published.events] == ["agent.responding", "agent.responded"]


@pytest.mark.unit
class TestMarkdownTakesLinearTime:
    """An agent's text is converted on every reply: no input it can write may hold a worker for long."""

    @pytest.mark.parametrize(
        "text",
        [
            "# a" + " " * 11_990 + "b",
            "`" * 12_000,
            "`a" * 6_000,
            "[&" * 6_000,
            " *&" * 4_000,
            "**a" * 4_000,
            "~~a" * 4_000,
            "a http://" * 1_300,
        ],
    )
    def test_worst_cases_are_quick(self, text):
        started = time.monotonic()
        markdown_to_html(text, agent_replies.MAX_REPLY_CHARS)
        assert time.monotonic() - started < 1

    def test_headings_lose_only_closing_hashes(self):
        assert markdown_to_html("# Title ##", 100) == "<p><strong>Title</strong></p>"
        assert markdown_to_html("# C#", 100) == "<p><strong>C#</strong></p>"

    def test_a_code_span_closes_on_as_many_backticks(self):
        assert markdown_to_html("use `a ``b`` c` and ``x`y``", 100) == (
            "<p>use <code>a ``b`` c</code> and <code>x`y</code></p>"
        )
        assert markdown_to_html("one ` stays", 100) == "<p>one ` stays</p>"
