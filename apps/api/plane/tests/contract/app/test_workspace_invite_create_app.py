# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Creating workspace invitations in the app (``WorkspaceInvitationsViewset.create``)."""

from unittest import mock

import pytest
from rest_framework import status

from plane.db.models import WorkspaceMember, WorkspaceMemberInvite
from plane.tests.factories import UserFactory


def _invites_url(slug):
    return f"/api/workspaces/{slug}/invitations/"


@pytest.fixture
def web_url(settings):
    settings.WEB_URL = "http://app.test"
    settings.APP_BASE_URL = None
    return settings.WEB_URL


@pytest.fixture
def task():
    with mock.patch("plane.utils.workspace_invite.workspace_invitation") as task:
        yield task


@pytest.mark.contract
@pytest.mark.django_db
class TestCreateWorkspaceInvitationApp:
    def test_invites_are_created_and_emails_queued(self, session_client, workspace, create_user, web_url, task):
        response = session_client.post(
            _invites_url(workspace.slug),
            {"emails": [{"email": "One@Plane.so", "role": 15}, {"email": "two@plane.so", "role": 5}]},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK, response.content
        invites = {invite.email: invite for invite in WorkspaceMemberInvite.objects.filter(workspace=workspace)}
        assert set(invites) == {"one@plane.so", "two@plane.so"}
        assert all(invite.token for invite in invites.values())
        task.delay.assert_has_calls(
            [
                mock.call(invite.email, workspace.id, invite.token, web_url, create_user.email)
                for invite in invites.values()
            ],
            any_order=True,
        )
        assert task.delay.call_count == 2

    def test_existing_member_is_rejected(self, session_client, workspace, web_url, task):
        member = UserFactory(email="member@plane.so")
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)

        response = session_client.post(
            _invites_url(workspace.slug), {"emails": [{"email": "Member@Plane.so", "role": 15}]}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.content
        assert not WorkspaceMemberInvite.objects.filter(workspace=workspace).exists()
        task.delay.assert_not_called()
