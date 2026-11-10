# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agents that answer when they are @mentioned in a channel.

A message mentions an agent with `<mention-component entity_name="agent_mention" entity_identifier="<agent id>">`. It is
its own entity, so nothing that reads user mentions (inbox entries, the email digest, work item assignees) sees it.

What starts a session, all checked again in the worker once the message has committed (`respond_to_mentions`):

- a new message or thread reply; an edit that adds a mention starts nothing;
- sent by a person, never by an agent (so agents can't set each other off) or by Nexus;
- who may run agents in the workspace (an active admin or member, never a guest) and is in the channel;
- in a public or private channel that isn't archived;
- mentioning an agent that is in the channel (a live `ChannelAgent` row) and enabled in the registry.

Each mention then has to get past the limits (`settings.CHAT_RATE_LIMITS`): sessions per person, sessions per agent in
the channel, and one running session per agent per thread. A mention while the agent is still on an earlier one in the
same thread gets a short note instead of waiting in a queue: the earlier answer may already cover it, and a queue
would hold work nobody can see or cancel.

A session runs in the agent bridge (`apps/agent-bridge`, `POST /internal/channel-sessions`), as the person who
mentioned the agent: the bridge mints a token for them, so the agent's Plane tools can do only what they can, and
revokes it when the session ends. It works at the level the channel gave the agent (clamped by the bridge). Nobody can
answer a permission prompt from a channel, so the bridge refuses every one and lists them; the reply says so.

The prompt is built here from that channel only: the thread the mention is in, or the last top-level messages of the
channel, without removed messages, with people and agents named. The bridge posts what the agent said back to
`POST /api/internal/chat/agent-replies/`, which calls `finish_run`. That checks everything again (the agent is still in
the channel and enabled, the channel is still open, the mention wasn't deleted), then posts the reply in the thread as
the agent, mentioning whoever asked so it reaches their inbox. If the session fails, the agent posts a short note
saying why (`Message.agent_notice`), so a mention never goes unanswered without a word.

While the agent works, `agent.responding` and then `agent.responded` events tell the channel's readers.
"""

import json
import uuid
from datetime import timezone as dt_timezone

import requests
from bs4 import BeautifulSoup
from celery import shared_task
from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.db.models import Q

from plane.app.permissions.agent_bridge import AGENT_BRIDGE_SECRET_HEADER
from plane.app.permissions.base import ROLE
from plane.chat.agents import effective_permission_level
from plane.chat.events import EventType, agent_reply_event, message_event, publish_on_commit
from plane.chat.markdown import markdown_to_html
from plane.chat.models import AgentNotice, ChannelAgent, ChannelMember, Message, plain_text
from plane.chat.models.channel import NAMED_KINDS
from plane.chat.notifications import notify_mentions
from plane.chat.throttles import allow
from plane.db.models import User, WorkspaceMember
from plane.license.models import AgentDefinition
from plane.utils.exception_logger import log_exception

AGENT_MENTION = "agent_mention"
# Agents one message can set off; more mentions than this are ignored.
MAX_AGENTS_PER_MESSAGE = 3

# Context for a top-level mention: the channel's last top-level messages. For a reply: the thread, up to this many.
CHANNEL_CONTEXT_MESSAGES = 20
THREAD_CONTEXT_MESSAGES = 50
MAX_CONTEXT_MESSAGE_CHARS = 2_000
MAX_CONTEXT_CHARS = 24_000
MAX_MENTION_CHARS = 8_000

# Markdown kept from an agent's reply; the rest is cut off (with an ellipsis).
MAX_REPLY_CHARS = 12_000
# Permission prompts named in a reply.
MAX_PERMISSION_TITLES = 5
MAX_PERMISSION_TITLE_CHARS = 200

# How long the bridge may take to accept a session; the session itself then runs there.
BRIDGE_REQUEST_TIMEOUT = 10
# A run outlives its timeout by this much, for the bridge to post what happened.
RUN_GRACE_SECONDS = 60

WORK_ITEM_UPDATES = "Work item updates"
SOMEONE = "Someone"

NOTICE_TEXT = {
    AgentNotice.TIMEOUT: "I ran out of time before I could finish, so I stopped.",
    AgentNotice.UNAVAILABLE: "I can't reply right now: the agent service is unavailable. Try again later.",
    AgentNotice.CREDENTIALS: (
        "I can't reply: I don't have working credentials for my AI provider. "
        "An admin can set them up in the workspace's AI provider settings."
    ),
    AgentNotice.FAILED: "Something went wrong while I was working on this, so I couldn't reply.",
    AgentNotice.EMPTY: "I finished without anything to say. Try asking again with more detail.",
    AgentNotice.RATE_LIMITED: "I've been asked too often in a short time. Try again in a few minutes.",
    AgentNotice.STILL_WORKING: "I'm still working on the last request in this thread. Ask again once I've replied.",
}
# What the bridge reports, as the note to post.
BRIDGE_ERRORS = {
    "timeout": AgentNotice.TIMEOUT,
    "unavailable": AgentNotice.UNAVAILABLE,
    "busy": AgentNotice.UNAVAILABLE,
    "credentials": AgentNotice.CREDENTIALS,
    "failed": AgentNotice.FAILED,
}


class BridgeUnavailable(Exception):
    pass


# ── mentions and who may set agents off ─────────────────────────────────────


def mentioned_agent_ids(html):
    """The agents `html` mentions, in order, once each, at most `MAX_AGENTS_PER_MESSAGE`."""
    if not html or AGENT_MENTION not in html:
        return []
    ids = []
    for tag in BeautifulSoup(html, "html.parser").find_all("mention-component", attrs={"entity_name": AGENT_MENTION}):
        try:
            agent_id = uuid.UUID(str(tag.get("entity_identifier")))
        except ValueError:
            continue
        if agent_id not in ids:
            ids.append(agent_id)
    return ids[:MAX_AGENTS_PER_MESSAGE]


def may_run_agents(workspace_id, user_id):
    """An active admin or member of the workspace: who may run agents. Guests and bots may not."""
    return WorkspaceMember.objects.filter(
        workspace_id=workspace_id,
        member_id=user_id,
        is_active=True,
        role__gte=ROLE.MEMBER.value,
        member__is_active=True,
        member__is_bot=False,
    ).exists()


def can_set_off_agents(message):
    """Whether a person sent `message` who may run agents and is in its channel. An agent's or Nexus's never can."""
    if message.sender_id is None:
        return False
    if not may_run_agents(message.workspace_id, message.sender_id):
        return False
    return ChannelMember.objects.filter(channel_id=message.channel_id, user_id=message.sender_id).exists()


def channel_is_open(channel):
    """A public or private channel that hasn't been archived or deleted."""
    return channel.kind in NAMED_KINDS and channel.archived_at is None and channel.deleted_at is None


def live_channel_agent(channel_id, agent_id):
    """The agent's row in the channel if it is still there and enabled in the registry, else None."""
    return (
        ChannelAgent.objects.filter(
            channel_id=channel_id,
            agent_id=agent_id,
            agent__is_enabled=True,
            agent__deleted_at__isnull=True,
        )
        .select_related("agent")
        .first()
    )


def queue_agent_replies(message):
    """Have the worker answer the agents a new message mentions, once it commits. Edits never call this."""
    if message.sender_id is None or not mentioned_agent_ids(message.body_html):
        return
    message_id = str(message.id)

    def enqueue():
        try:
            respond_to_mentions.delay(message_id)
        except Exception as error:
            # The message is saved; a broker outage must not fail the request that sent it.
            log_exception(error)

    transaction.on_commit(enqueue)


# ── the prompt ───────────────────────────────────────────────────────────────


def _clip(text, limit):
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


class _Names:
    """What to call the people and agents in a set of messages: display names, the registry's names."""

    def __init__(self, workspace_id, messages):
        user_ids, agent_ids = set(), set()
        for message in messages:
            if message.sender_id:
                user_ids.add(str(message.sender_id))
            for tag in _mentions(message.body_html):
                (agent_ids if tag.get("entity_name") == AGENT_MENTION else user_ids).add(
                    str(tag.get("entity_identifier"))
                )
        slugs = {message.sender_agent for message in messages if message.sender_agent}
        # People are named only if they are in the workspace: a mention of anyone else names nobody.
        self.people = {
            str(user_id): name
            for user_id, name in User.objects.filter(
                id__in=[i for i in user_ids if _is_uuid(i)],
                member_workspace__workspace_id=workspace_id,
                member_workspace__is_active=True,
            ).values_list("id", "display_name")
        }
        agents = AgentDefinition.objects.filter(Q(id__in=[i for i in agent_ids if _is_uuid(i)]) | Q(slug__in=slugs))
        self.agents_by_id = {str(agent.id): agent.name for agent in agents}
        self.agents_by_slug = {agent.slug: agent.name for agent in agents}

    def sender(self, message):
        if message.system_event:
            return WORK_ITEM_UPDATES
        if message.sender_agent:
            return self.agents_by_slug.get(message.sender_agent, "Removed agent")
        return self.people.get(str(message.sender_id)) or SOMEONE

    def text(self, message):
        """The message as plain text, mentions written as @name."""
        if "mention-component" not in message.body_html:
            return message.body_stripped
        soup = BeautifulSoup(message.body_html, "html.parser")
        for tag in soup.find_all("mention-component"):
            identifier = str(tag.get("entity_identifier"))
            if tag.get("entity_name") == AGENT_MENTION:
                name = self.agents_by_id.get(identifier, "an agent")
            elif tag.get("entity_name") == "user_mention":
                name = self.people.get(identifier, SOMEONE.lower())
            else:
                name = None
            tag.replace_with(f"@{name}" if name else "")
        return plain_text(str(soup))


def _mentions(html):
    if not html or "mention-component" not in html:
        return []
    return BeautifulSoup(html, "html.parser").find_all("mention-component")


def _is_uuid(value):
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _stamp(message):
    return message.created_at.astimezone(dt_timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def context_messages(message):
    """What the agent is shown besides `message`, oldest first: its thread so far, or the channel's last messages.

    Only from `message`'s channel, never removed messages, and no more than the context limits.
    """
    alive = Message.objects.filter(
        channel_id=message.channel_id, removed_at__isnull=True, created_at__lte=message.created_at
    ).exclude(pk=message.pk)
    if message.parent_id:
        earlier = alive.filter(Q(pk=message.parent_id) | Q(parent_id=message.parent_id))
        limit = THREAD_CONTEXT_MESSAGES
    else:
        earlier = alive.filter(parent__isnull=True)
        limit = CHANNEL_CONTEXT_MESSAGES
    newest_first = list(earlier.order_by("-created_at", "-id")[:limit])
    return newest_first[::-1]


def build_prompt(message, agent_id):
    """The prompt for the agent `message` mentioned, or None if it isn't in the channel and enabled any more."""
    channel_agent = live_channel_agent(message.channel_id, agent_id)
    if channel_agent is None:
        return None
    channel = message.channel
    earlier = context_messages(message)
    names = _Names(message.workspace_id, [message, *earlier])
    asker = names.sender(message)

    lines, used = [], 0
    for item in reversed(earlier):
        block = f"--- {names.sender(item)}, {_stamp(item)}\n{_clip(names.text(item), MAX_CONTEXT_MESSAGE_CHARS)}"
        if used + len(block) > MAX_CONTEXT_CHARS:
            break
        lines.append(block)
        used += len(block)
    lines.reverse()

    where = f"#{channel.name}" + (" (a private channel)" if channel.kind == "private" else "")
    scope = "earlier in this thread" if message.parent_id else f"the latest messages in {where}"
    parts = [
        f"You are {channel_agent.agent.name}, an agent in Nexus Messages. {asker} mentioned you in {where} and is "
        "waiting for your answer, which will be posted as your reply in the thread.",
        f"You act with {asker}'s permissions in Plane. Nobody can approve a permission prompt from Messages, so any "
        "tool call that needs approval will be refused.",
        "Answer in Markdown, briefly and to the point. Don't repeat the conversation back.",
    ]
    if lines:
        parts.append(f"Messages {scope}, oldest first:\n\n" + "\n\n".join(lines))
    parts.append(f"{asker}'s message to you:\n\n{_clip(names.text(message), MAX_MENTION_CHARS)}")
    return "\n\n".join(parts)


# ── runs ─────────────────────────────────────────────────────────────────────


def _run_key(run_id):
    return f"chat:agent-run:{run_id}"


def thread_lock_key(agent_id, root_id):
    """Held while the agent works on a mention in the thread whose first message is `root_id`."""
    return f"chat:agent-thread:{agent_id}:{root_id}"


def _run_ttl():
    return settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS + RUN_GRACE_SECONDS


def _start_bridge_session(run_id, message, channel_agent, prompt):
    """Ask the bridge to run the session. It answers at once; what the agent says comes back to `finish_run`."""
    base = settings.AGENT_BRIDGE_INTERNAL_URL
    secret = settings.AGENT_BRIDGE_SECRET
    if not base or not secret:
        raise BridgeUnavailable("agent replies are not configured")
    try:
        response = requests.post(
            f"{base}/internal/channel-sessions",
            data=json.dumps(
                {
                    "run_id": run_id,
                    "user_id": str(message.sender_id),
                    "workspace_slug": message.workspace.slug,
                    "agent_id": str(channel_agent.agent_id),
                    "permission_level": effective_permission_level(channel_agent),
                    "prompt": prompt,
                    "timeout_ms": settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS * 1000,
                }
            ),
            headers={AGENT_BRIDGE_SECRET_HEADER: secret, "Content-Type": "application/json"},
            timeout=BRIDGE_REQUEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as error:
        raise BridgeUnavailable(str(error)) from error
    if response.status_code == 429:
        raise BridgeUnavailable("the bridge is at capacity")
    if response.status_code != 202:
        raise BridgeUnavailable(f"the bridge answered {response.status_code}")


def start_run(message, channel_agent):
    """Answer one agent mention in `message`: a session in the bridge, or a note saying why not."""
    agent = channel_agent.agent
    root_id = message.parent_id or message.id
    lock = thread_lock_key(agent.id, root_id)
    # Before the limits, so asking again while it works costs nothing.
    if cache.get(lock) is not None:
        post_reply(message, agent.id, notice=AgentNotice.STILL_WORKING)
        return None
    if not allow("agent_session", message.sender_id) or not allow("agent_channel", f"{agent.id}:{message.channel_id}"):
        post_reply(message, agent.id, notice=AgentNotice.RATE_LIMITED)
        return None

    run_id = uuid.uuid4().hex
    if not cache.add(lock, run_id, _run_ttl()):
        post_reply(message, agent.id, notice=AgentNotice.STILL_WORKING)
        return None
    # Kept a little longer than the lock, for `expire_run` to find it.
    cache.set(
        _run_key(run_id),
        {"message_id": str(message.id), "agent_id": str(agent.id), "lock": lock},
        _run_ttl() + RUN_GRACE_SECONDS,
    )
    publish_on_commit(agent_reply_event(EventType.AGENT_RESPONDING, message, agent.id))

    prompt = build_prompt(message, agent.id)
    if prompt is None:
        finish_run(run_id, None)
        return None
    try:
        _start_bridge_session(run_id, message, channel_agent, prompt)
    except BridgeUnavailable as error:
        log_exception(error, warning=True)
        finish_run(run_id, {"status": "failed", "error": "unavailable"})
        return None
    try:
        expire_run.apply_async((run_id,), countdown=_run_ttl())
    except Exception as error:
        # The session runs anyway; only the note for a bridge that never reports is lost.
        log_exception(error)
    return run_id


@shared_task
def expire_run(run_id):
    """A run the bridge never reported on (it restarted mid-session, say): post the failure note and free the thread.

    Does nothing to a run that has finished.
    """
    finish_run(run_id, {"status": "failed", "error": "failed"})


@shared_task
def respond_to_mentions(message_id):
    """Start a session for each agent a new message mentions, if the message may set agents off."""
    message = Message.objects.filter(pk=message_id).select_related("channel", "workspace").first()
    if message is None or message.removed_at is not None:
        return
    if not channel_is_open(message.channel) or not can_set_off_agents(message):
        return
    for agent_id in mentioned_agent_ids(message.body_html):
        channel_agent = live_channel_agent(message.channel_id, agent_id)
        if channel_agent is None:
            continue
        try:
            start_run(message, channel_agent)
        except Exception as error:
            log_exception(error)


def _claim_run(run_id):
    """The run's record, taken so that only one caller ever finishes it; None if it is unknown or finished."""
    key = _run_key(run_id)
    run = cache.get(key)
    if run is None or not cache.delete(key):
        return None
    return run


def finish_run(run_id, outcome):
    """Post what the bridge reported for a run (None: nothing to post), and end it.

    Returns (posted message or None, reason): `unknown` for a run that doesn't exist or already finished.
    """
    run = _claim_run(run_id)
    if run is None:
        return None, "unknown"
    message = Message.objects.filter(pk=run["message_id"]).select_related("channel", "workspace").first()
    try:
        if message is None or outcome is None:
            return None, "gone"
        if outcome.get("status") == "ok":
            return post_reply(
                message,
                run["agent_id"],
                text=outcome.get("text") or "",
                permission_requests=outcome.get("permission_requests") or [],
            )
        return post_reply(message, run["agent_id"], notice=BRIDGE_ERRORS.get(outcome.get("error"), AgentNotice.FAILED))
    finally:
        if cache.get(run["lock"]) == run_id:
            cache.delete(run["lock"])
        if message is not None:
            publish_on_commit(agent_reply_event(EventType.AGENT_RESPONDED, message, run["agent_id"]))


# ── posting ──────────────────────────────────────────────────────────────────


def _asker_mention(user_id):
    attributes = f'entity_name="user_mention" entity_identifier="{user_id}" id="{user_id}"'
    return f"<mention-component {attributes}></mention-component>"


def _permission_sentences(titles):
    seen = []
    for title in titles:
        if isinstance(title, str) and title.strip():
            clean = " ".join(title.split())[:MAX_PERMISSION_TITLE_CHARS]
            # "Edit work item" reads as "…permission to edit work item"; a name like "WEB-12" stays as it is.
            if clean[1:2].islower():
                clean = clean[0].lower() + clean[1:]
            if clean not in seen:
                seen.append(clean)
    return [
        f"I needed permission to {title}, which can't be granted from Messages yet."
        for title in seen[:MAX_PERMISSION_TITLES]
    ]


def reply_html(asker_id, text="", permission_requests=(), notice=None):
    """The body of an agent's reply: the asker mentioned, then the agent's Markdown (or the note) and any refusals."""
    if notice is not None:
        markdown = NOTICE_TEXT[notice]
    else:
        markdown = (text or "").strip()
        refusals = _permission_sentences(permission_requests)
        if refusals:
            markdown = "\n\n".join([part for part in (markdown, " ".join(refusals)) if part])
    html = markdown_to_html(markdown, MAX_REPLY_CHARS)
    mention = _asker_mention(asker_id) + " "
    if html.startswith("<p>"):
        return "<p>" + mention + html[len("<p>") :]
    return f"<p>{mention.strip()}</p>{html}"


def refusal_reason(message, agent_id):
    """Why the agent may not post in reply to `message` now (None if it may)."""
    if message.removed_at is not None:
        return "message_removed"
    if not channel_is_open(message.channel):
        return "channel_closed"
    if live_channel_agent(message.channel_id, agent_id) is None:
        return "agent_unavailable"
    return None


def post_reply(message, agent_id, text="", permission_requests=(), notice=None):
    """Post the agent's reply (or a note) in `message`'s thread, after checking it still may.

    Returns (the reply or None, reason).
    """
    reason = refusal_reason(message, agent_id)
    if reason is not None:
        return None, reason
    channel_agent = live_channel_agent(message.channel_id, agent_id)
    if notice is None and not (text or "").strip() and not permission_requests:
        notice = AgentNotice.EMPTY
    if not allow("agent_post", channel_agent.agent_id):
        return None, "rate_limited"
    with transaction.atomic():
        reply = Message.objects.create(
            channel=message.channel,
            sender_agent=channel_agent.agent.slug,
            parent_id=message.parent_id or message.id,
            body_html=reply_html(message.sender_id, text, permission_requests, notice),
            agent_notice=notice,
        )
        publish_on_commit(message_event(EventType.MESSAGE_CREATED, reply))
        notify_mentions(reply)
    return reply, None
