# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import re

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import AgentBridgeSecretPermission
from plane.app.views.base import BaseAPIView
from plane.chat.agent_dm import request_permission, update_draft
from plane.chat.agent_replies import BRIDGE_ERRORS, finish_run

_RUN_ID = re.compile(r"[0-9a-f]{32}")
# What the bridge sends at most; the reply is cut much shorter before it is posted.
MAX_TEXT_CHARS = 200_000
MAX_PERMISSION_REQUESTS = 50
MAX_TOOL_CALLS = 50
MAX_SESSION_REF_CHARS = 255
MAX_OPTIONS = 10
_LABEL = 200

# Why nothing was posted, as the bridge is told.
_REFUSED = {
    "gone": status.HTTP_409_CONFLICT,
    "message_removed": status.HTTP_409_CONFLICT,
    "channel_closed": status.HTTP_409_CONFLICT,
    "agent_unavailable": status.HTTP_409_CONFLICT,
    "person_unavailable": status.HTTP_409_CONFLICT,
    "rate_limited": status.HTTP_429_TOO_MANY_REQUESTS,
}


def _without_nul(value):
    """`value` with NUL characters taken out of every string in it: Postgres stores none in text or jsonb."""
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, list):
        return [_without_nul(item) for item in value]
    if isinstance(value, dict):
        return {_without_nul(key): _without_nul(item) for key, item in value.items()}
    return value


def _bridge_data(request):
    """The bridge's JSON body, or {} if it isn't an object. An agent's text can hold anything, NULs included."""
    return _without_nul(request.data) if isinstance(request.data, dict) else {}


def _short_string(value, limit=_LABEL):
    return isinstance(value, str) and len(value) <= limit


def _tool_calls(value):
    """An agent DM turn's tool calls as the bridge sends them, or None if they aren't valid."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TOOL_CALLS:
        return None
    for call in value:
        if not isinstance(call, dict) or not _short_string(call.get("id")) or not _short_string(call.get("title")):
            return None
        if not isinstance(call.get("status"), str):
            return None
    return value


def _dm_extras(data):
    """What only an agent DM's bridge report has: partial text on failure, tool calls, the ACP session, why it stopped.

    None if any of them is invalid.
    """
    tool_calls = _tool_calls(data.get("tool_calls"))
    session_ref = data.get("session_ref")
    stop_reason = data.get("stop_reason")
    if tool_calls is None:
        return None
    if session_ref is not None and not _short_string(session_ref, MAX_SESSION_REF_CHARS):
        return None
    if stop_reason is not None and not _short_string(stop_reason, 64):
        return None
    return {"tool_calls": tool_calls, "session_ref": session_ref, "stop_reason": stop_reason}


def _outcome(data):
    """The bridge's report as `finish_run` takes it, or None if it isn't one."""
    result = data.get("status")
    if result == "ok":
        text = data.get("text", "")
        titles = data.get("permission_requests", [])
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
            return None
        if not isinstance(titles, list) or len(titles) > MAX_PERMISSION_REQUESTS:
            return None
        if not all(isinstance(title, str) for title in titles):
            return None
        extras = _dm_extras(data)
        if extras is None:
            return None
        return {"status": "ok", "text": text, "permission_requests": titles, **extras}
    if result == "failed":
        error = data.get("error")
        text = data.get("text", "")
        extras = _dm_extras(data)
        if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS or extras is None:
            return None
        return {"status": "failed", "error": error if error in BRIDGE_ERRORS else "failed", "text": text, **extras}
    return None


class ChatAgentReplyEndpoint(BaseAPIView):
    """Bridge-only: what an agent said about a mention in Nexus Messages, to post as its reply.

    Authenticated solely by ``AgentBridgeSecretPermission``. ``run_id`` is the run the API started
    (`plane.chat.agent_replies.start_run`), and only that run's agent can reply, once, in that message's thread, after
    everything that let the mention set it off is checked again.

    Body: ``{run_id, status: "ok", text, permission_requests: [<tool title>]}`` or ``{run_id, status: "failed",
    error}``. A turn in an agent DM (`plane.chat.agent_dm`) may also send ``tool_calls`` (``[{id, title, status}]``),
    ``session_ref`` (the ACP session to resume next time), ``stop_reason`` and, on failure, the ``text`` written so far;
    its reply is the draft finalised, or a new message.

    Answers 201 with the posted message's ID; 404 for an unknown or finished run; 409 when the agent may not post any
    more; 429 when the agent has posted too often. Nothing is retried after 404, 409 or 429.
    """

    authentication_classes = []
    permission_classes = [AgentBridgeSecretPermission]
    # One service IP sends every request; the shared secret gates access.
    throttle_classes = []

    def post(self, request):
        data = _bridge_data(request)
        run_id = data.get("run_id")
        outcome = _outcome(data)
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id) or outcome is None:
            return Response({"error": "A run_id and a valid outcome are required."}, status=status.HTTP_400_BAD_REQUEST)
        reply, reason = finish_run(run_id, outcome)
        if reply is not None:
            return Response({"message_id": str(reply.id)}, status=status.HTTP_201_CREATED)
        if reason == "unknown":
            return Response({"error": "Unknown or finished run."}, status=status.HTTP_404_NOT_FOUND)
        return Response({"error": reason}, status=_REFUSED.get(reason, status.HTTP_409_CONFLICT))


def _bad_request():
    return Response({"error": "A run_id and a valid report are required."}, status=status.HTTP_400_BAD_REQUEST)


def _refused(reason):
    if reason == "unknown":
        return Response({"error": "Unknown or finished run."}, status=status.HTTP_404_NOT_FOUND)
    return Response({"error": reason}, status=_REFUSED.get(reason, status.HTTP_409_CONFLICT))


class _BridgeOnlyEndpoint(BaseAPIView):
    authentication_classes = []
    permission_classes = [AgentBridgeSecretPermission]
    throttle_classes = []


class ChatAgentDraftEndpoint(_BridgeOnlyEndpoint):
    """Bridge-only: what the agent has written so far in a turn in an agent DM, shown as its draft reply.

    Body: ``{run_id, text, tool_calls: [{id, title, status}]}``, the whole text each time. Answers 200 with the draft's
    ID (null while there is nothing to show); 404 for an unknown or finished run; 409 when the agent may no longer
    post there, and the bridge then stops the turn.
    """

    def post(self, request):
        data = _bridge_data(request)
        run_id, text, tool_calls = data.get("run_id"), data.get("text", ""), _tool_calls(data.get("tool_calls"))
        valid_run = isinstance(run_id, str) and _RUN_ID.fullmatch(run_id)
        if not valid_run or not isinstance(text, str) or len(text) > MAX_TEXT_CHARS or tool_calls is None:
            return _bad_request()
        draft, reason = update_draft(run_id, text, tool_calls)
        if reason is not None:
            return _refused(reason)
        return Response({"message_id": str(draft.id) if draft else None})


class ChatAgentPermissionEndpoint(_BridgeOnlyEndpoint):
    """Bridge-only: the agent in an agent DM asks its person to approve a tool call.

    Body: ``{run_id, request_id, title, options: [{option_id, name, kind}]}``; ``request_id`` is the bridge's, which
    waits for the answer. Answers 201; 404 for an unknown or finished run; 409 when the agent may no longer post there
    (the bridge then refuses the tool call).
    """

    def post(self, request):
        data = _bridge_data(request)
        run_id, request_id = data.get("run_id"), data.get("request_id")
        title, options = data.get("title", ""), data.get("options")
        ids_valid = all(isinstance(value, str) and _RUN_ID.fullmatch(value) for value in (run_id, request_id))
        options_valid = (
            isinstance(options, list)
            and 0 < len(options) <= MAX_OPTIONS
            and all(
                isinstance(option, dict)
                and _short_string(option.get("option_id"))
                and option.get("option_id")
                and _short_string(option.get("name"))
                and _short_string(option.get("kind"), 32)
                for option in options
            )
        )
        if not ids_valid or not _short_string(title) or not options_valid:
            return _bad_request()
        created, reason = request_permission(run_id, request_id, title, options)
        if reason == "invalid":
            return _bad_request()
        if reason is not None:
            return _refused(reason)
        return Response({"id": created.request_id}, status=status.HTTP_201_CREATED)
