# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agent state when a workspace membership ends.

POST /api/internal/agent-offboarding/ (bridge-only), and the removal, leave and
account-deactivation paths, which delete the member's agent credentials and
revoke their agent-session tokens.
"""

import uuid
from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import AgentProviderCredential, APIToken, Profile, User, Workspace, WorkspaceMember
from plane.db.models.api import AGENT_SESSION_TOKEN_LABEL

OFFBOARDING_URL = "/api/internal/agent-offboarding/"
BRIDGE_SECRET = "test-bridge-secret-0123456789abcdef"


@pytest.fixture(autouse=True)
def _bridge_settings(settings):
    settings.AGENT_BRIDGE_SECRET = BRIDGE_SECRET


@pytest.fixture
def bridge_client():
    client = APIClient()
    client.credentials(HTTP_X_AGENT_BRIDGE_SECRET=BRIDGE_SECRET)
    return client


@pytest.fixture
def member(workspace):
    user = User.objects.create(email="offboard-member@plane.so", username="offboard-member")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


def _client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _give_agent_state(workspace, user):
    """A personal API key, an account sign-in record and a live agent-session token."""
    key = AgentProviderCredential(workspace=workspace, user=user, provider="anthropic")
    key.set_api_key("sk-ant-personal-key")
    key.save()
    AgentProviderCredential.objects.create(
        workspace=workspace, user=user, provider="openai", method="chatgpt", account_label="me@example.com"
    )
    return APIToken.objects.create(
        user=user,
        workspace=workspace,
        label=AGENT_SESSION_TOKEN_LABEL,
        user_type=0,
        expired_at=timezone.now() + timedelta(hours=1),
    )


def _shared_key(workspace):
    row = AgentProviderCredential(workspace=workspace, user=None, provider="anthropic")
    row.set_api_key("sk-ant-workspace-key")
    row.save()
    return row


def _assert_agent_state_removed(workspace, user, token):
    assert not AgentProviderCredential.all_objects.filter(workspace=workspace, user=user).exists()
    token.refresh_from_db()
    assert token.is_active is False


def _assert_agent_state_kept(workspace, user, token):
    assert AgentProviderCredential.objects.filter(workspace=workspace, user=user).count() == 2
    token.refresh_from_db()
    assert token.is_active is True


def _pair(workspace_id, user_id):
    return {"workspace_id": str(workspace_id), "user_id": str(user_id)}


@pytest.mark.contract
class TestMembershipEndRemovesAgentState:
    @pytest.mark.django_db
    def test_admin_removing_a_member(self, session_client, create_user, workspace, member):
        token = _give_agent_state(workspace, member)
        admin_token = _give_agent_state(workspace, create_user)
        shared = _shared_key(workspace)
        membership = WorkspaceMember.objects.get(workspace=workspace, member=member)

        response = session_client.delete(f"/api/workspaces/{workspace.slug}/members/{membership.id}/")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        _assert_agent_state_removed(workspace, member, token)
        _assert_agent_state_kept(workspace, create_user, admin_token)
        assert AgentProviderCredential.objects.filter(pk=shared.pk).exists()

    @pytest.mark.django_db
    def test_member_leaving(self, create_user, workspace, member):
        token = _give_agent_state(workspace, member)
        admin_token = _give_agent_state(workspace, create_user)

        response = _client_for(member).post(f"/api/workspaces/{workspace.slug}/members/leave/")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        _assert_agent_state_removed(workspace, member, token)
        _assert_agent_state_kept(workspace, create_user, admin_token)

    @pytest.mark.django_db
    def test_member_deactivating_their_account(self, create_user, workspace, member):
        other = Workspace.objects.create(name="Other", owner=create_user, slug="offboard-other")
        WorkspaceMember.objects.create(workspace=other, member=member, role=15)
        token = _give_agent_state(workspace, member)
        other_token = _give_agent_state(other, member)
        Profile.objects.get_or_create(user=member)

        with mock.patch("plane.app.views.user.base.user_deactivation_email"):
            response = _client_for(member).delete("/api/users/me/")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        _assert_agent_state_removed(workspace, member, token)
        _assert_agent_state_removed(other, member, other_token)


@pytest.mark.contract
class TestAgentOffboardingEndpoint:
    @pytest.mark.django_db
    @pytest.mark.parametrize("secret", [None, BRIDGE_SECRET + "x"])
    def test_requires_bridge_secret(self, workspace, member, secret):
        client = APIClient()
        if secret:
            client.credentials(HTTP_X_AGENT_BRIDGE_SECRET=secret)
        WorkspaceMember.objects.filter(workspace=workspace, member=member).update(is_active=False)
        token = _give_agent_state(workspace, member)

        response = client.post(OFFBOARDING_URL, {"members": [_pair(workspace.id, member.id)]}, format="json")

        assert response.status_code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)
        _assert_agent_state_kept(workspace, member, token)

    @pytest.mark.django_db
    def test_reports_only_ended_memberships(self, bridge_client, create_user, workspace, member):
        guest = User.objects.create(email="offboard-guest@plane.so", username="offboard-guest")
        WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)
        removed = User.objects.create(email="offboard-removed@plane.so", username="offboard-removed")
        WorkspaceMember.objects.create(workspace=workspace, member=removed, role=15, is_active=False)
        deleted_ws = Workspace.objects.create(name="Gone", owner=create_user, slug="offboard-gone")
        WorkspaceMember.objects.create(workspace=deleted_ws, member=create_user, role=20)
        Workspace.objects.filter(pk=deleted_ws.pk).update(deleted_at=timezone.now())
        unknown_ws = uuid.uuid4()
        members = [
            _pair(workspace.id, create_user.id),
            _pair(workspace.id, member.id),
            _pair(workspace.id, guest.id),
            _pair(workspace.id, removed.id),
            _pair(deleted_ws.id, create_user.id),
            _pair(unknown_ws, member.id),
            _pair(workspace.id, removed.id),
        ]

        response = bridge_client.post(OFFBOARDING_URL, {"members": members}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert response.json() == {
            "ended": [
                _pair(workspace.id, removed.id),
                _pair(deleted_ws.id, create_user.id),
                _pair(unknown_ws, member.id),
            ]
        }

    @pytest.mark.django_db
    def test_removes_credentials_and_tokens_of_ended_memberships(self, bridge_client, create_user, workspace, member):
        token = _give_agent_state(workspace, member)
        admin_token = _give_agent_state(workspace, create_user)
        shared = _shared_key(workspace)
        WorkspaceMember.objects.filter(workspace=workspace, member=member).update(is_active=False)

        response = bridge_client.post(
            OFFBOARDING_URL,
            {"members": [_pair(workspace.id, member.id), _pair(workspace.id, create_user.id)]},
            format="json",
        )

        assert response.json() == {"ended": [_pair(workspace.id, member.id)]}
        _assert_agent_state_removed(workspace, member, token)
        _assert_agent_state_kept(workspace, create_user, admin_token)
        assert AgentProviderCredential.objects.filter(pk=shared.pk).exists()

    @pytest.mark.django_db
    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"members": "nope"},
            {"members": [{"workspace_id": "not-a-uuid", "user_id": str(uuid.uuid4())}]},
            {"members": [{"workspace_id": str(uuid.uuid4())}]},
            {"members": ["x"]},
            {"members": [_pair(uuid.uuid4(), uuid.uuid4())] * 501},
        ],
    )
    def test_rejects_bad_input(self, bridge_client, body):
        response = bridge_client.post(OFFBOARDING_URL, body, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_empty_list(self, bridge_client):
        response = bridge_client.post(OFFBOARDING_URL, {"members": []}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == {"ended": []}
