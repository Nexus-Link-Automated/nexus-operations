# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import AgentBridgeSecretPermission
from plane.app.views.base import BaseAPIView
from plane.app.views.internal.agent_session import _parse_uuid
from plane.db.models import WorkspaceMember
from plane.utils.agent_credentials import end_agent_access

# Most members one request may ask about; the bridge sends larger sets in chunks.
MAX_OFFBOARDING_MEMBERS = 500


class AgentOffboardingEndpoint(BaseAPIView):
    """Bridge-only: which of these memberships have ended?

    The bridge sends the ``(workspace_id, user_id)`` pairs it holds agent state for (live
    chats, directories on the agent runner). The answer lists the pairs with no active
    membership in a live workspace; the bridge then closes their chats and clears their
    runner directories. Credentials and agent-session tokens still stored for those pairs
    are removed here as well, whichever way the membership ended.
    """

    authentication_classes = []
    permission_classes = [AgentBridgeSecretPermission]
    throttle_classes = []

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        members = data.get("members")
        if not isinstance(members, list) or len(members) > MAX_OFFBOARDING_MEMBERS:
            return Response(
                {"error": f"members must be a list of at most {MAX_OFFBOARDING_MEMBERS} entries."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        pairs = []
        for entry in members:
            entry = entry if isinstance(entry, dict) else {}
            workspace_id = _parse_uuid(entry.get("workspace_id"))
            user_id = _parse_uuid(entry.get("user_id"))
            if not workspace_id or not user_id:
                return Response(
                    {"error": "Each member needs a workspace_id and a user_id."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            pairs.append((workspace_id, user_id))
        if not pairs:
            return Response({"ended": []}, status=status.HTTP_200_OK)

        active = set(
            WorkspaceMember.objects.filter(
                workspace_id__in={workspace_id for workspace_id, _ in pairs},
                member_id__in={user_id for _, user_id in pairs},
                is_active=True,
                workspace__deleted_at__isnull=True,
            ).values_list("workspace_id", "member_id")
        )
        ended = list(dict.fromkeys(pair for pair in pairs if pair not in active))
        end_agent_access(ended)
        return Response(
            {
                "ended": [
                    {"workspace_id": str(workspace_id), "user_id": str(user_id)} for workspace_id, user_id in ended
                ]
            },
            status=status.HTTP_200_OK,
        )
