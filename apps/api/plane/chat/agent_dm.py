# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent DMs: a person's own conversation with one agent from the registry, in Nexus Messages.

An agent DM (`ChannelKind.AGENT_DM`) holds exactly one person (a `ChannelMember`) and one agent (a `ChannelAgent`,
whose `permission_level` is the person's choice for this DM, up to the registry's maximum). It is opened through
`agent-dms/` by an admin or member of the workspace, never a guest, and only its person can see it: workspace admins
can't, as with a DM between people. It can't be renamed, archived, linked to a project or given anyone else.

It is read-only (`read_only_reason`) while the registry has the agent disabled or deleted, or once its person may no
longer run agents (made a guest, say).

Every top-level message the person sends starts a turn (`respond_in_agent_dm`); no mention is needed. Thread replies
are allowed, but never go to the agent. One turn runs at a time: a message sent meanwhile waits, and when the turn
ends the next one starts with every message the person has sent since the agent was last prompted
(`AgentDmSession.prompted_until`). Stop (`stop_turn`) cancels the running turn.

The turn runs in the agent bridge (`POST /internal/dm-turns`), which holds the agent's ACP session for the DM while it
is in use, as the DM's person (the bridge mints the token for them), at the DM's level (clamped again there). The
bridge reports the ACP session ID, kept in `AgentDmSession`, to resume it later with `session/load`; a new session
gets `primer` instead of `prompt`: the recent conversation as well as the new messages.

While the agent writes, the bridge posts the text so far (`update_draft`, throttled), shown as a draft reply
(`Message.agent_streaming`) through `message.updated`. The final report (`plane.chat.agent_replies.finish_run`, which
hands DM runs to `finish_dm_run`) finalises it, with the turn's tool calls; only then does it count as unread and
reach the person's inbox. Every report is checked again first: the run is still current, the DM isn't read-only.

A tool call that needs approval reaches the API as an `AgentPermissionRequest` (`request_permission`), which the
person answers in the DM (`answer_permission`); the answer goes to the bridge. An unanswered one expires with the
turn and is refused. Channels (`plane.chat.agent_replies`) still refuse every prompt themselves.
"""

import json
import uuid
from datetime import datetime, timedelta

import requests
from celery import shared_task
from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.app.permissions.agent_bridge import AGENT_BRIDGE_SECRET_HEADER
from plane.chat.agent_replies import (
    BRIDGE_ERRORS,
    BRIDGE_REQUEST_TIMEOUT,
    MAX_CONTEXT_CHARS,
    MAX_CONTEXT_MESSAGE_CHARS,
    MAX_MENTION_CHARS,
    MAX_REPLY_CHARS,
    NOTICE_TEXT,
    RUN_GRACE_SECONDS,
    BridgeUnavailable,
    _clip,
    _Names,
    _run_key,
    _run_ttl,
    _stamp,
    expire_run,
    live_channel_agent,
    may_run_agents,
)
from plane.chat.agents import effective_permission_level
from plane.chat.attachments import assets
from plane.chat.events import EventType, agent_dm_event, agent_permission_event, message_event, publish_on_commit
from plane.chat.markdown import markdown_to_html
from plane.chat.models import (
    AgentDmSession,
    AgentNotice,
    AgentPermissionRequest,
    AgentPermissionStatus,
    Channel,
    ChannelAgent,
    Message,
)
from plane.chat.notifications import notify_agent_reply
from plane.chat.throttles import allow
from plane.utils.exception_logger import log_exception

# The conversation a new session is shown, besides the new messages.
HISTORY_MESSAGES = 30
# The new messages one turn gives the agent, all together.
MAX_NEW_CHARS = 40_000
MAX_TOOL_CALLS = 50
MAX_TOOL_TITLE_CHARS = 200
TOOL_STATUSES = ("pending", "in_progress", "completed", "failed")

READ_ONLY_AGENT_UNAVAILABLE = "agent_unavailable"
READ_ONLY_AGENT_REMOVED = "agent_removed"
READ_ONLY_CANNOT_RUN_AGENTS = "cannot_run_agents"
READ_ONLY_MESSAGES = {
    READ_ONLY_AGENT_UNAVAILABLE: "This agent has been turned off, so the conversation is read-only.",
    READ_ONLY_AGENT_REMOVED: "This agent has been removed, so the conversation is read-only.",
    READ_ONLY_CANNOT_RUN_AGENTS: "You can no longer use agents in this workspace, so the conversation is read-only.",
}


class TurnNotRunning(Exception):
    pass


# ── who and what ─────────────────────────────────────────────────────────────


def dm_person_id(channel):
    """The ID of the agent DM's person, from its key (`agent:<user id>:<agent id>`)."""
    return channel.dm_key.split(":")[1]


def dm_agent_id(channel):
    return channel.dm_key.split(":")[2]


def dm_channel_agent(channel):
    """The DM's agent row, whatever the registry says about the agent now; None once the registry deleted it."""
    return ChannelAgent.objects.filter(channel_id=channel.id).select_related("agent").first()


def read_only_reason(channel, channel_agent=None):
    """Why nothing more can be said in the agent DM, or None. `channel_agent` saves a query if already read."""
    row = channel_agent if channel_agent is not None else dm_channel_agent(channel)
    if row is None or row.agent.deleted_at is not None:
        return READ_ONLY_AGENT_REMOVED
    if not row.agent.is_enabled:
        return READ_ONLY_AGENT_UNAVAILABLE
    if not may_run_agents(channel.workspace_id, dm_person_id(channel)):
        return READ_ONLY_CANNOT_RUN_AGENTS
    return None


def turn_lock_key(channel_id):
    """Held while a turn runs in the agent DM; its value is the run's ID."""
    return f"chat:agent-dm:{channel_id}"


def _queued_key(channel_id):
    """Set when the person sent something while a turn was running: the next turn starts when it ends."""
    return f"chat:agent-dm-queued:{channel_id}"


def _draft_key(run_id):
    return f"chat:agent-run-draft:{run_id}"


def draft_id(run_id):
    """The draft reply the run is writing, if it has started one."""
    return cache.get(_draft_key(run_id))


def running_run_id(channel_id):
    return cache.get(turn_lock_key(channel_id))


def is_responding(channel_id):
    return running_run_id(channel_id) is not None


def queue_dm_turn(message):
    """Have the worker start a turn for the person's new top-level message in an agent DM, once it commits."""
    if message.sender_id is None or message.parent_id is not None:
        return
    message_id = str(message.id)

    def enqueue():
        try:
            respond_in_agent_dm.delay(message_id)
        except Exception as error:
            log_exception(error)

    transaction.on_commit(enqueue)


# ── the prompts ──────────────────────────────────────────────────────────────


def _unprompted(channel, session):
    """The person's top-level messages the agent hasn't been given yet, oldest first."""
    messages = Message.objects.filter(
        channel=channel, parent__isnull=True, sender_id=dm_person_id(channel), removed_at__isnull=True
    )
    if session.prompted_until is not None:
        messages = messages.filter(created_at__gt=session.prompted_until)
    return list(messages.order_by("created_at", "id"))


def _history(channel, new_messages):
    """The rest of the conversation, oldest first, without `new_messages`: what a new session is shown."""
    earlier = (
        Message.objects.filter(
            channel=channel,
            parent__isnull=True,
            removed_at__isnull=True,
            agent_notice__isnull=True,
            agent_streaming=False,
        )
        .exclude(pk__in=[message.pk for message in new_messages])
        .order_by("-created_at", "-id")[:HISTORY_MESSAGES]
    )
    return list(earlier)[::-1]


def _files_note(message):
    """What a message's files say in a prompt: the agent can't open them, but it should know they were sent."""
    files = [
        str(asset.attributes.get("name") or "a file") if isinstance(asset.attributes, dict) else "a file"
        for asset in assets().filter(entity_identifier=str(message.pk), is_uploaded=True).order_by("created_at")
    ]
    if not files:
        return ""
    return f"[Sent {len(files)} file{'s' if len(files) > 1 else ''}, which you can't open here: {', '.join(files)}]"


def build_dm_prompts(channel, channel_agent, new_messages):
    """`(prompt, primer)` for a turn: the new messages alone, for a session that has the rest; or with the history."""
    history = _history(channel, new_messages)
    names = _Names(channel.workspace_id, [*history, *new_messages])
    agent_name = channel_agent.agent.name
    person = names.sender(new_messages[0])

    def text_of(item):
        # A message can be only files, and the bridge takes no empty prompt.
        return "\n\n".join(part for part in (names.text(item), _files_note(item)) if part.strip())

    new_parts, used = [], 0
    for item in new_messages:
        text = _clip(text_of(item), MAX_MENTION_CHARS)
        if used + len(text) > MAX_NEW_CHARS:
            break
        new_parts.append(text)
        used += len(text)
    joined = "\n\n---\n\n".join(new_parts)
    prompt = new_parts[0] if len(new_parts) == 1 else f"{person} sent these messages, oldest first:\n\n{joined}"

    lines, used = [], 0
    for item in reversed(history):
        block = f"--- {names.sender(item)}, {_stamp(item)}\n{_clip(text_of(item), MAX_CONTEXT_MESSAGE_CHARS)}"
        if used + len(block) > MAX_CONTEXT_CHARS:
            break
        lines.append(block)
        used += len(block)
    lines.reverse()

    parts = [
        f"You are {agent_name}, an agent in Nexus Messages, in a direct conversation with {person}. Everything "
        f"{person} writes here is meant for you, and your answers are posted as your replies.",
        f"You act with {person}'s permissions in Plane. When a tool call needs approval, {person} is asked in this "
        "conversation.",
        "Answer in Markdown, briefly and to the point.",
    ]
    if lines:
        parts.append("Earlier in this conversation, oldest first:\n\n" + "\n\n".join(lines))
    if len(new_parts) == 1:
        parts.append(f"{person}'s new message to you:\n\n{joined}")
    else:
        parts.append(f"{person}'s new messages to you, oldest first:\n\n{joined}")
    return prompt, "\n\n".join(parts)


# ── starting a turn ──────────────────────────────────────────────────────────


@shared_task
def respond_in_agent_dm(message_id):
    """Start a turn for the person's new message in their agent DM (or leave it queued behind the running one)."""
    message = Message.objects.filter(pk=message_id).select_related("channel", "workspace").first()
    if message is None or message.removed_at is not None or message.parent_id is not None:
        return
    channel = message.channel
    if not channel.is_agent_dm or channel.deleted_at is not None or message.sender_id is None:
        return
    if str(message.sender_id) != dm_person_id(channel):
        return
    start_dm_turn(channel)


@shared_task
def start_queued_dm_turn(channel_id):
    channel = Channel.objects.filter(pk=channel_id).select_related("workspace").first()
    if channel is not None and channel.is_agent_dm:
        start_dm_turn(channel)


def _start_bridge_turn(run_id, channel, channel_agent, prompt, primer, session_ref):
    base = settings.AGENT_BRIDGE_INTERNAL_URL
    secret = settings.AGENT_BRIDGE_SECRET
    if not base or not secret:
        raise BridgeUnavailable("agent replies are not configured")
    try:
        response = requests.post(
            f"{base}/internal/dm-turns",
            data=json.dumps(
                {
                    "run_id": run_id,
                    "channel_id": str(channel.id),
                    "user_id": dm_person_id(channel),
                    "workspace_slug": channel.workspace.slug,
                    "agent_id": str(channel_agent.agent_id),
                    "permission_level": effective_permission_level(channel_agent),
                    "prompt": prompt,
                    "primer": primer,
                    "session_ref": session_ref or None,
                    "timeout_ms": settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS * 1000,
                }
            ),
            headers={AGENT_BRIDGE_SECRET_HEADER: secret, "Content-Type": "application/json"},
            timeout=BRIDGE_REQUEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as error:
        raise BridgeUnavailable(str(error)) from error
    if response.status_code != 202:
        raise BridgeUnavailable(f"the bridge answered {response.status_code}")


def _wait_for_running_turn(channel_id):
    """Whether a turn is running, in which case the next one is noted to start when it ends."""
    lock = turn_lock_key(channel_id)
    if cache.get(lock) is None:
        return False
    cache.set(_queued_key(channel_id), "1", _run_ttl() + RUN_GRACE_SECONDS)
    # It may have ended between the two: then nothing would pick the note up, so start now instead.
    return cache.get(lock) is not None


def start_dm_turn(channel):
    """Give the agent what the person has said since it was last prompted, unless a turn is already running.

    Returns the run's ID, or None when nothing started (nothing new, read-only, a turn running, or a note instead).
    """
    channel_agent = live_channel_agent(channel.id, dm_agent_id(channel))
    if channel_agent is None or read_only_reason(channel, channel_agent) is not None:
        return None
    lock = turn_lock_key(channel.id)
    if _wait_for_running_turn(channel.id):
        return None
    try:
        session, _ = AgentDmSession.objects.get_or_create(channel=channel)
    except IntegrityError:
        session = AgentDmSession.objects.get(channel=channel)
    new_messages = _unprompted(channel, session)
    if not new_messages:
        return None
    if not allow("agent_dm_turn", dm_person_id(channel)):
        # Left unprompted, so the next turn the person starts includes them.
        post_dm_message(channel, channel_agent, notice=AgentNotice.RATE_LIMITED)
        return None

    run_id = uuid.uuid4().hex
    if not cache.add(lock, run_id, _run_ttl()):
        # Another worker started one a moment ago.
        cache.set(_queued_key(channel.id), "1", _run_ttl() + RUN_GRACE_SECONDS)
        return None
    cache.delete(_queued_key(channel.id))
    latest = new_messages[-1]
    cache.set(
        _run_key(run_id),
        {
            "kind": "dm",
            "channel_id": str(channel.id),
            "message_id": str(latest.id),
            "agent_id": str(channel_agent.agent_id),
            "lock": lock,
            "started_at": timezone.now().isoformat(),
        },
        _run_ttl() + RUN_GRACE_SECONDS,
    )
    publish_on_commit(agent_dm_event(EventType.AGENT_RESPONDING, channel, channel_agent.agent_id, latest.id))

    prompt, primer = build_dm_prompts(channel, channel_agent, new_messages)
    try:
        _start_bridge_turn(run_id, channel, channel_agent, prompt, primer, session.session_ref)
    except BridgeUnavailable as error:
        log_exception(error, warning=True)
        from plane.chat.agent_replies import finish_run

        finish_run(run_id, {"status": "failed", "error": "unavailable"})
        return None
    # Given to the agent now, so a failure later on doesn't give them to it again in the next turn.
    AgentDmSession.objects.filter(pk=session.pk).update(prompted_until=latest.created_at, updated_at=timezone.now())
    try:
        expire_run.apply_async((run_id,), countdown=_run_ttl())
    except Exception as error:
        log_exception(error)
    return run_id


# ── what the bridge reports ──────────────────────────────────────────────────


def _dm_run(run_id):
    """The running DM turn `run_id`, without ending it; None if it is unknown, finished or not a DM's."""
    run = cache.get(_run_key(run_id))
    if not run or run.get("kind") != "dm":
        return None
    return run


def _run_channel(run):
    return Channel.objects.filter(pk=run["channel_id"]).select_related("workspace").first()


def refusal(channel, run_id):
    """Why the agent may not post in the DM for run `run_id` now (None if it may)."""
    if channel is None or channel.deleted_at is not None:
        return "gone"
    if running_run_id(channel.id) != run_id:
        return "gone"
    reason = read_only_reason(channel)
    if reason is not None:
        return "agent_unavailable" if reason != READ_ONLY_CANNOT_RUN_AGENTS else "person_unavailable"
    return None


def clean_tool_calls(tool_calls):
    """The tool calls as stored on a reply: at most `MAX_TOOL_CALLS`, each `{id, title, status}` and nothing else."""
    cleaned = []
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        status = call.get("status") if call.get("status") in TOOL_STATUSES else "pending"
        title = " ".join(str(call.get("title") or "").split())[:MAX_TOOL_TITLE_CHARS]
        cleaned.append({"id": str(call.get("id") or "")[:MAX_TOOL_TITLE_CHARS], "title": title, "status": status})
    return cleaned[:MAX_TOOL_CALLS] or None


def _reply_body(text):
    html = markdown_to_html((text or "").strip(), MAX_REPLY_CHARS)
    return html or "<p></p>"


def update_draft(run_id, text, tool_calls):
    """Show what the agent has written so far. Returns (draft or None, refusal reason or None)."""
    run = _dm_run(run_id)
    if run is None:
        return None, "unknown"
    channel = _run_channel(run)
    reason = refusal(channel, run_id)
    if reason is not None:
        return None, reason
    tool_calls = clean_tool_calls(tool_calls)
    draft_id = cache.get(_draft_key(run_id))
    with transaction.atomic():
        if draft_id is None:
            if not (text or "").strip() and not tool_calls:
                return None, None
            agent = ChannelAgent.objects.select_related("agent").get(channel=channel)
            draft = Message.objects.create(
                channel=channel,
                sender_agent=agent.agent.slug,
                body_html=_reply_body(text),
                agent_streaming=True,
                agent_tool_calls=tool_calls,
            )
            cache.set(_draft_key(run_id), str(draft.id), _run_ttl() + RUN_GRACE_SECONDS)
            publish_on_commit(message_event(EventType.MESSAGE_CREATED, draft))
            return draft, None
        draft = Message.objects.select_for_update().filter(pk=draft_id, agent_streaming=True).first()
        if draft is None or draft.removed_at is not None:
            return None, "message_removed"
        draft.body_html = _reply_body(text)
        draft.agent_tool_calls = tool_calls
        draft.save(update_fields=["body_html", "body_stripped", "agent_tool_calls", "updated_at"])
        publish_on_commit(message_event(EventType.MESSAGE_UPDATED, draft))
    return draft, None


def _clean_options(options):
    cleaned = []
    for option in options or []:
        if not isinstance(option, dict) or not isinstance(option.get("option_id"), str):
            continue
        cleaned.append(
            {
                "option_id": option["option_id"][:200],
                "name": " ".join(str(option.get("name") or "").split())[:200],
                "kind": option.get("kind") if isinstance(option.get("kind"), str) else "",
            }
        )
    return cleaned


def request_permission(run_id, request_id, title, options):
    """Ask the DM's person to approve a tool call. Returns (the request or None, refusal reason or None)."""
    run = _dm_run(run_id)
    if run is None:
        return None, "unknown"
    channel = _run_channel(run)
    reason = refusal(channel, run_id)
    if reason is not None:
        return None, reason
    options = _clean_options(options)
    if not options:
        return None, "invalid"
    started = datetime.fromisoformat(run["started_at"])
    if AgentPermissionRequest.objects.filter(request_id=request_id).exists():
        return None, "invalid"
    with transaction.atomic():
        request = AgentPermissionRequest.objects.create(
            channel=channel,
            run_id=run_id,
            request_id=request_id,
            title=" ".join((title or "").split())[:200],
            options=options,
            expires_at=started + timedelta(seconds=settings.CHAT_AGENT_REPLY_TIMEOUT_SECONDS),
        )
        publish_on_commit(
            agent_permission_event(
                EventType.AGENT_PERMISSION_REQUESTED,
                channel,
                dm_person_id(channel),
                run["agent_id"],
                cache.get(_draft_key(run_id)),
            )
        )
    return request, None


def pending_permissions(channel):
    """The DM's permission requests still waiting for an answer, oldest first."""
    run_id = running_run_id(channel.id)
    if run_id is None:
        return AgentPermissionRequest.objects.none()
    return AgentPermissionRequest.objects.filter(
        channel=channel, run_id=run_id, status=AgentPermissionStatus.PENDING, expires_at__gt=timezone.now()
    ).order_by("created_at", "id")


def _bridge_post(path, body):
    base = settings.AGENT_BRIDGE_INTERNAL_URL
    secret = settings.AGENT_BRIDGE_SECRET
    if not base or not secret:
        raise BridgeUnavailable("agent replies are not configured")
    try:
        response = requests.post(
            f"{base}{path}",
            data=json.dumps(body),
            headers={AGENT_BRIDGE_SECRET_HEADER: secret, "Content-Type": "application/json"},
            timeout=BRIDGE_REQUEST_TIMEOUT,
            allow_redirects=False,
        )
    except requests.RequestException as error:
        raise BridgeUnavailable(str(error)) from error
    return response.status_code


class PermissionGone(Exception):
    """The request isn't waiting for an answer any more."""


class UnknownOption(Exception):
    pass


def answer_permission(channel, request_id, option_id):
    """The DM's person answers a pending permission request; the bridge passes it on to the agent.

    Raises `PermissionGone` if it isn't pending (answered, expired, its turn over), `UnknownOption`, or
    `BridgeUnavailable` (left pending, to try again).
    """
    with transaction.atomic():
        request = (
            AgentPermissionRequest.objects.select_for_update().filter(channel=channel, request_id=request_id).first()
        )
        if request is None:
            raise AgentPermissionRequest.DoesNotExist
        current = request.status == AgentPermissionStatus.PENDING and request.expires_at > timezone.now()
        if not current or running_run_id(channel.id) != request.run_id:
            raise PermissionGone
        # The agent disabled or removed, or the person no longer allowed to run agents, since it asked: a tool call
        # approved now would run with rights they no longer have.
        if refusal(channel, request.run_id) is not None:
            raise PermissionGone
        if option_id not in [option["option_id"] for option in request.options]:
            raise UnknownOption
        # Taken first, so a second answer from another tab finds it answered.
        request.status = AgentPermissionStatus.ANSWERED
        request.option_id = option_id
        request.save(update_fields=["status", "option_id", "updated_at", "updated_by"])
    try:
        status_code = _bridge_post(
            f"/internal/dm-turns/{channel.id}/permissions/{request_id}",
            {"run_id": request.run_id, "option_id": option_id},
        )
    except BridgeUnavailable:
        AgentPermissionRequest.objects.filter(pk=request.pk).update(
            status=AgentPermissionStatus.PENDING, option_id="", updated_at=timezone.now()
        )
        raise
    if status_code != 204:
        AgentPermissionRequest.objects.filter(pk=request.pk).update(
            status=AgentPermissionStatus.EXPIRED, updated_at=timezone.now()
        )
        _publish_resolved(channel, request.run_id)
        raise PermissionGone
    _publish_resolved(channel, request.run_id)
    return request


def _publish_resolved(channel, run_id, agent_id=None):
    agent_id = agent_id or dm_agent_id(channel)
    publish_on_commit(
        agent_permission_event(
            EventType.AGENT_PERMISSION_RESOLVED, channel, dm_person_id(channel), agent_id, cache.get(_draft_key(run_id))
        )
    )


def stop_turn(channel):
    """Stop the turn running in the agent DM. Raises `TurnNotRunning` if none is, `BridgeUnavailable`."""
    run_id = running_run_id(channel.id)
    if run_id is None:
        raise TurnNotRunning
    status_code = _bridge_post(f"/internal/dm-turns/{channel.id}/cancel", {"run_id": run_id})
    if status_code == 404:
        # The bridge has no such turn (it restarted, say): end it here, so the DM isn't stuck.
        from plane.chat.agent_replies import finish_run

        finish_run(run_id, {"status": "ok", "text": "", "stop_reason": "cancelled"})
    elif status_code != 202:
        raise BridgeUnavailable(f"the bridge answered {status_code}")
    return run_id


# ── posting ──────────────────────────────────────────────────────────────────


def post_dm_message(channel, channel_agent, text="", notice=None, tool_calls=None):
    """Post the agent's message in the DM (a note if `notice`), as final. Returns it."""
    body = NOTICE_TEXT[notice] if notice is not None else text
    with transaction.atomic():
        reply = Message.objects.create(
            channel=channel,
            sender_agent=channel_agent.agent.slug,
            body_html=_reply_body(body),
            agent_notice=notice,
            agent_tool_calls=tool_calls,
        )
        publish_on_commit(message_event(EventType.MESSAGE_CREATED, reply))
        notify_agent_reply(reply, dm_person_id(channel))
    return reply


def _finalise_draft(draft, text=None, tool_calls=None, notify=True):
    """Mark the draft written: with the final text and tool calls if given, else as it stands."""
    with transaction.atomic():
        fields = ["agent_streaming", "updated_at"]
        draft.agent_streaming = False
        if text is not None:
            draft.body_html = _reply_body(text)
            fields += ["body_html", "body_stripped"]
        if tool_calls is not None:
            draft.agent_tool_calls = tool_calls
            fields.append("agent_tool_calls")
        draft.save(update_fields=fields)
        publish_on_commit(message_event(EventType.MESSAGE_UPDATED, draft))
        if notify:
            notify_agent_reply(draft, dm_person_id(draft.channel))
    return draft


def _expire_permissions(channel, run_id):
    expired = AgentPermissionRequest.objects.filter(
        channel=channel, run_id=run_id, status=AgentPermissionStatus.PENDING
    ).update(status=AgentPermissionStatus.EXPIRED, updated_at=timezone.now())
    if expired:
        _publish_resolved(channel, run_id)


def finish_dm_run(run_id, run, outcome):
    """Post what the bridge reported for a DM turn (claimed by `finish_run`), and end the turn.

    Returns (posted or finalised reply or None, reason).
    """
    channel = _run_channel(run)
    draft_id = cache.get(_draft_key(run_id))
    draft = None
    if draft_id is not None:
        draft = Message.objects.filter(pk=draft_id, agent_streaming=True).select_related("channel").first()
    try:
        if channel is None or channel.deleted_at is not None:
            return None, "gone"
        channel_agent = live_channel_agent(channel.id, run["agent_id"])
        reason = read_only_reason(channel, channel_agent or dm_channel_agent(channel))
        if outcome is None or reason is not None:
            if draft is not None and draft.removed_at is None:
                # Already shown: leave it as it stands rather than writing on for an agent that may no longer post.
                _finalise_draft(draft, notify=False)
            return None, "gone" if outcome is None else "agent_unavailable"

        tool_calls = clean_tool_calls(outcome.get("tool_calls"))
        text = (outcome.get("text") or "").strip()
        if outcome.get("session_ref"):
            AgentDmSession.objects.filter(channel=channel).update(
                session_ref=outcome["session_ref"][:255], updated_at=timezone.now()
            )
        if outcome.get("status") == "ok":
            stopped = outcome.get("stop_reason") == "cancelled"
            if draft is not None and draft.removed_at is None:
                return _finalise_draft(draft, text if text else None, tool_calls), None
            if text or tool_calls:
                if not text:
                    text = NOTICE_TEXT[AgentNotice.STOPPED] if stopped else NOTICE_TEXT[AgentNotice.EMPTY]
                return post_dm_message(channel, channel_agent, text=text, tool_calls=tool_calls), None
            notice = AgentNotice.STOPPED if stopped else AgentNotice.EMPTY
            return post_dm_message(channel, channel_agent, notice=notice), None

        notice = BRIDGE_ERRORS.get(outcome.get("error"), AgentNotice.FAILED)
        if draft is not None and draft.removed_at is None:
            # What the agent managed to write stays, followed by why it stopped.
            _finalise_draft(draft, text if text else None, tool_calls, notify=False)
        elif text:
            post_dm_message(channel, channel_agent, text=text, tool_calls=tool_calls)
        return post_dm_message(channel, channel_agent, notice=notice), None
    finally:
        if cache.get(run["lock"]) == run_id:
            cache.delete(run["lock"])
        cache.delete(_draft_key(run_id))
        if channel is not None:
            _expire_permissions(channel, run_id)
            publish_on_commit(agent_dm_event(EventType.AGENT_RESPONDED, channel, run["agent_id"], run["message_id"]))
            if cache.get(_queued_key(channel.id)) is not None:
                cache.delete(_queued_key(channel.id))
                channel_id = str(channel.id)

                def enqueue():
                    try:
                        start_queued_dm_turn.delay(channel_id)
                    except Exception as error:
                        log_exception(error)

                transaction.on_commit(enqueue)
