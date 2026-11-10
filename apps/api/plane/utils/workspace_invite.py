# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace invitation steps shared by the app and the public API."""

# Python imports
from datetime import datetime

# Third party imports
import jwt

# Django imports
from django.conf import settings

# Module imports
from plane.bgtasks.workspace_invitation_task import workspace_invitation
from plane.db.models import WorkspaceMember


def normalize_invite_email(email):
    # Accounts store their email lowercased (User.save), so invitations do too.
    return email.strip().lower()


def workspace_invite_token(email):
    """The token the invitation email carries and the join endpoint checks."""
    return jwt.encode(
        {"email": email, "timestamp": datetime.now().timestamp()},
        settings.SECRET_KEY,
        algorithm="HS256",
    )


def active_members_with_emails(workspace_id, emails):
    """Active members of the workspace whose account email is one of ``emails``."""
    return WorkspaceMember.objects.filter(
        workspace_id=workspace_id,
        member__email__in=[normalize_invite_email(email) for email in emails if isinstance(email, str)],
        is_active=True,
    )


def send_workspace_invitations(invitations, workspace_id, current_site, inviter_email):
    for invitation in invitations:
        workspace_invitation.delay(
            invitation.email,
            workspace_id,
            invitation.token,
            current_site,
            inviter_email,
        )
