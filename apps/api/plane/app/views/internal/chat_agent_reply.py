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
from plane.chat.agent_replies import BRIDGE_ERRORS, finish_run

_RUN_ID = re.compile(r"[0-9a-f]{32}")
# What the bridge sends at most; the reply is cut much shorter before it is posted.
MAX_TEXT_CHARS = 200_000
MAX_PERMISSION_REQUESTS = 50

# Why nothing was posted, as the bridge is told.
_REFUSED = {
    "gone": status.HTTP_409_CONFLICT,
    "message_removed": status.HTTP_409_CONFLICT,
    "channel_closed": status.HTTP_409_CONFLICT,
    "agent_unavailable": status.HTTP_409_CONFLICT,
    "rate_limited": status.HTTP_429_TOO_MANY_REQUESTS,
}


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
        return {"status": "ok", "text": text, "permission_requests": titles}
    if result == "failed":
        error = data.get("error")
        return {"status": "failed", "error": error if error in BRIDGE_ERRORS else "failed"}
    return None


class ChatAgentReplyEndpoint(BaseAPIView):
    """Bridge-only: what an agent said about a mention in Nexus Messages, to post as its reply.

    Authenticated solely by ``AgentBridgeSecretPermission``. ``run_id`` is the run the API started
    (`plane.chat.agent_replies.start_run`), and only that run's agent can reply, once, in that message's thread, after
    everything that let the mention set it off is checked again.

    Body: ``{run_id, status: "ok", text, permission_requests: [<tool title>]}`` or ``{run_id, status: "failed",
    error}``. Answers 201 with the posted message's ID; 404 for an unknown or finished run; 409 when the agent may not
    post any more; 429 when the agent has posted too often. Nothing is retried after 404, 409 or 429.
    """

    authentication_classes = []
    permission_classes = [AgentBridgeSecretPermission]
    # One service IP sends every request; the shared secret gates access.
    throttle_classes = []

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
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
