# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Creating workspace invitations through the public API (v1).

An invitation made here must work like one made in the app: it carries a token,
stores the email lowercased, refuses existing members and queues the email.
"""

from unittest import mock

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import WorkspaceMember, WorkspaceMemberInvite
from plane.tests.factories import UserFactory


def _invites_url(slug):
    return f"/api/v1/workspaces/{slug}/invitations/"


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
class TestCreateWorkspaceInvitation:
    def test_invite_gets_token_and_email_is_queued(self, api_key_client, workspace, create_user, web_url, task):
        response = api_key_client.post(
            _invites_url(workspace.slug), {"email": "New.Person@Example.com", "role": 15}, format="json"
        )

        assert response.status_code == status.HTTP_201_CREATED, response.content
        invite = WorkspaceMemberInvite.objects.get(workspace=workspace)
        assert invite.email == "new.person@example.com"
        assert invite.token
        assert "token" not in response.json()
        task.delay.assert_called_once_with(invite.email, workspace.id, invite.token, web_url, create_user.email)

    def test_invite_can_be_accepted_with_the_emailed_token(self, api_key_client, workspace, web_url, task):
        response = api_key_client.post(
            _invites_url(workspace.slug), {"email": "Joiner@Plane.so", "role": 15}, format="json"
        )
        assert response.status_code == status.HTTP_201_CREATED, response.content
        token = task.delay.call_args.args[2]

        joiner = UserFactory(email="joiner@plane.so")
        client = APIClient()
        client.force_authenticate(user=joiner)
        join = client.post(
            f"/api/workspaces/{workspace.slug}/invitations/{response.json()['id']}/join/",
            {"token": token, "accepted": True},
            format="json",
        )

        assert join.status_code == status.HTTP_200_OK, join.content
        assert WorkspaceMember.objects.filter(workspace=workspace, member=joiner, role=15, is_active=True).exists()

    def test_existing_member_is_rejected(self, api_key_client, workspace, web_url, task):
        member = UserFactory(email="member@plane.so")
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)

        response = api_key_client.post(
            _invites_url(workspace.slug), {"email": "Member@Plane.so", "role": 15}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.content
        assert response.json()["code"] == "USER_ALREADY_MEMBER"
        assert not WorkspaceMemberInvite.objects.filter(workspace=workspace).exists()
        task.delay.assert_not_called()

    def test_duplicate_invite_is_rejected_regardless_of_case(self, api_key_client, workspace, web_url, task):
        WorkspaceMemberInvite.objects.create(workspace=workspace, email="pending@plane.so", token="t", role=15)

        response = api_key_client.post(
            _invites_url(workspace.slug), {"email": "Pending@Plane.so", "role": 15}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.content
        assert WorkspaceMemberInvite.objects.filter(workspace=workspace).count() == 1
        task.delay.assert_not_called()
