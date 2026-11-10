# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""An agent's messages carry its name from the registry wherever they show: lists, threads, search, inbox, email."""

from contextlib import ExitStack
from datetime import timedelta
from unittest import mock
from uuid import uuid4

import pytest
from django.conf import settings
from django.test import override_settings
from django.utils import timezone

from plane.chat import digest
from plane.chat.agents import REMOVED_AGENT_NAME
from plane.chat.models import Message, PendingMentionEmail
from plane.chat.notifications import notify_mentions
from plane.db.models import Notification
from plane.license.models import AgentDefinition

SMTP_CONFIG = ("smtp.example.com", "smtp-user", "smtp-password", "587", "1", "0", "Plane <noreply@example.com>")


def mention(user):
    return f'<mention-component entity_name="user_mention" entity_identifier="{user.id}"></mention-component>'


@pytest.fixture
def agent(db):
    return AgentDefinition.objects.create(name="Release bot", slug=f"release-{uuid4().hex[:6]}", adapter="codex")


@pytest.fixture
def channel(make_channel, member, member2):
    return make_channel(name="ops", members=[member.user, member2.user])


@pytest.fixture
def say():
    """The agent posts in `channel`, as Step 21 will: no person sends it."""

    def say(channel, slug, text="deploy finished", parent=None, mentioned=()):
        message = Message.objects.create(
            channel=channel,
            sender_agent=slug,
            parent=parent,
            body_html=f"<p>{text} {''.join(mention(user) for user in mentioned)}</p>",
        )
        notify_mentions(message)
        return message

    return say


def details(agent, available=True):
    return {
        "id": str(agent.id),
        "slug": agent.slug,
        "name": "Release bot",
        "adapter": "codex",
        "is_available": available,
    }


@pytest.mark.contract
@pytest.mark.django_db
class TestMessages:
    def test_the_channel_list_names_the_agent(self, member, channel, agent, say, send, url):
        say(channel, agent.slug)
        send(channel, member.user)
        agent_row, person_row = member.client.get(url(f"channels/{channel.id}/messages/")).data["results"]
        assert agent_row["sender_agent"] == agent.slug
        assert agent_row["sender_agent_details"] == details(agent)
        assert person_row["sender_agent_details"] is None

    def test_a_thread_names_it(self, member, channel, agent, say, send, url):
        parent = send(channel, member.user)
        say(channel, agent.slug, parent=parent)
        [reply] = member.client.get(url(f"channels/{channel.id}/messages/{parent.id}/replies/")).data["results"]
        assert reply["sender_agent_details"] == details(agent)

    def test_one_message_names_it(self, member, channel, agent, say, url):
        message = say(channel, agent.slug)
        response = member.client.get(url(f"channels/{channel.id}/messages/{message.id}/"))
        assert response.data["sender_agent_details"]["name"] == "Release bot"

    def test_search_results_name_it(self, member, channel, agent, say, url):
        say(channel, agent.slug, text="deploy finished")
        [result] = member.client.get(url("search/"), {"q": "deploy"}).data["results"]
        assert result["message"]["sender_agent_details"] == details(agent)

    def test_a_disabled_agent_keeps_its_name(self, member, channel, agent, say, url):
        say(channel, agent.slug)
        AgentDefinition.objects.filter(pk=agent.pk).update(is_enabled=False)
        [row] = member.client.get(url(f"channels/{channel.id}/messages/")).data["results"]
        assert row["sender_agent_details"] == details(agent, available=False)

    def test_an_agent_gone_from_the_registry_has_no_details(self, member, channel, agent, say, url):
        say(channel, agent.slug)
        agent.delete(soft=False)
        [row] = member.client.get(url(f"channels/{channel.id}/messages/")).data["results"]
        assert row["sender_agent"] and row["sender_agent_details"] is None
        assert row["body_html"]  # The message itself stays.

    def test_names_are_read_in_one_query_per_page(
        self, member, channel, agent, say, url, django_assert_max_num_queries
    ):
        for _ in range(3):
            say(channel, agent.slug)
        path = url(f"channels/{channel.id}/messages/")
        member.client.get(path)  # Warm up whatever the first request caches.
        with django_assert_max_num_queries(30) as captured:
            member.client.get(path)
        assert sum("agent_definitions" in query["sql"] for query in captured.captured_queries) == 1


@pytest.mark.contract
@pytest.mark.django_db
class TestInbox:
    def test_the_entry_names_the_agent(self, member, channel, agent, say):
        message = say(channel, agent.slug, mentioned=[member.user])
        entry = Notification.objects.get(receiver=member.user, entity_identifier=message.id)
        assert entry.title == "Release bot mentioned you in a message"
        assert entry.triggered_by_id is None
        assert entry.data["chat_message"]["sender_agent"] == {
            "slug": agent.slug,
            "name": "Release bot",
            "adapter": "codex",
        }

    def test_an_agent_gone_from_the_registry_is_a_removed_agent(self, member, channel, say):
        message = say(channel, "gone-agent", mentioned=[member.user])
        entry = Notification.objects.get(receiver=member.user, entity_identifier=message.id)
        assert entry.title == f"{REMOVED_AGENT_NAME} mentioned you in a message"
        # The inbox says "Removed agent" in the reader's language.
        assert entry.data["chat_message"]["sender_agent"] == {"slug": "gone-agent", "name": None, "adapter": None}


def _run_digest():
    task = digest.send_mention_digest_email
    with ExitStack() as stack:
        stack.enter_context(override_settings(WEB_URL="https://app.example.com", APP_BASE_URL=None))
        stack.enter_context(mock.patch.object(digest, "get_email_configuration", return_value=SMTP_CONFIG))
        stack.enter_context(mock.patch.object(task, "delay", side_effect=lambda *args: task.apply(args=args)))
        old = timezone.now() - timedelta(minutes=settings.CHAT_MENTION_EMAIL_DELAY_MINUTES, seconds=1)
        PendingMentionEmail.objects.update(created_at=old)
        digest.send_mention_digests()


@pytest.mark.contract
@pytest.mark.django_db
class TestDigest:
    def test_the_email_names_the_agent(self, member, channel, agent, say, mailoutbox):
        say(channel, agent.slug, mentioned=[member.user])
        _run_digest()
        [email] = mailoutbox
        assert email.subject == "Release bot mentioned you in #ops"
        assert agent.slug not in email.body

    def test_a_removed_agent_is_named_as_such(self, member, channel, say, mailoutbox):
        say(channel, "gone-agent", mentioned=[member.user])
        say(channel, "gone-agent", text="again", mentioned=[member.user])
        _run_digest()
        [email] = mailoutbox
        assert email.subject == "You have 2 unread mentions"
        assert REMOVED_AGENT_NAME in email.body and "gone-agent" not in email.body
