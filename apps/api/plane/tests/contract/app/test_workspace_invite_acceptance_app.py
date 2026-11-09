# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Joining a workspace from an invitation needs proof that the user controls the
invited address: a verified email (``POST /api/users/me/workspaces/invitations/``)
or the token delivered in the invitation email (``.../invitations/<pk>/join/``).
"""

import pytest
from django.test import RequestFactory
from rest_framework import status
from rest_framework.test import APIClient

from plane.authentication.adapter.base import Adapter
from plane.db.models import WorkspaceMember, WorkspaceMemberInvite
from plane.tests.factories import UserFactory

INVITATIONS_URL = "/api/users/me/workspaces/invitations/"
INVITEE_EMAIL = "invitee@plane.so"
EMAILED_TOKEN = "emailed-invitation-token"


def _join_url(slug, pk):
    return f"/api/workspaces/{slug}/invitations/{pk}/join/"


def _complete_sign_in(provider, is_password_autoset):
    request = RequestFactory().post("/", HTTP_USER_AGENT="pytest")
    adapter = Adapter(request=request, provider=provider)
    adapter.set_user_data({"email": INVITEE_EMAIL, "user": {"is_password_autoset": is_password_autoset}})
    adapter.complete_login_or_signup()


@pytest.fixture
def invitee(db):
    return UserFactory(email=INVITEE_EMAIL, is_email_verified=False)


@pytest.fixture
def invitee_client(invitee):
    client = APIClient()
    client.force_authenticate(user=invitee)
    return client


@pytest.fixture
def invite(workspace):
    return WorkspaceMemberInvite.objects.create(workspace=workspace, email=INVITEE_EMAIL, token=EMAILED_TOKEN, role=20)


@pytest.mark.contract
@pytest.mark.django_db
class TestAcceptWorkspaceInvitation:
    def test_accepting_by_id_needs_a_verified_email(self, invitee, invitee_client, workspace, invite):
        payload = {"invitations": [str(invite.id)]}

        response = invitee_client.post(INVITATIONS_URL, payload, format="json")

        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert not WorkspaceMember.objects.filter(workspace=workspace, member=invitee).exists()
        assert WorkspaceMemberInvite.objects.filter(pk=invite.pk).exists()

        invitee.is_email_verified = True
        invitee.save()

        response = invitee_client.post(INVITATIONS_URL, payload, format="json")

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert WorkspaceMember.objects.get(workspace=workspace, member=invitee).role == 20
        assert not WorkspaceMemberInvite.objects.filter(pk=invite.pk).exists()

    def test_emailed_token_is_accepted_without_a_verified_email(self, invitee, invitee_client, workspace, invite):
        response = invitee_client.post(INVITATIONS_URL, {"invitations": [str(invite.id)]}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN

        response = invitee_client.post(
            _join_url(workspace.slug, invite.id), {"accepted": True, "token": EMAILED_TOKEN}, format="json"
        )

        assert response.status_code == status.HTTP_200_OK
        assert WorkspaceMember.objects.get(workspace=workspace, member=invitee).role == 20

    @pytest.mark.parametrize("is_email_verified", [False, True])
    def test_invitation_list_leaves_out_the_emailed_token(self, invitee, invitee_client, invite, is_email_verified):
        invitee.is_email_verified = is_email_verified
        invitee.save()

        response = invitee_client.get(INVITATIONS_URL)

        assert response.status_code == status.HTTP_200_OK
        assert [str(row["id"]) for row in response.data] == [str(invite.id)]
        assert "token" not in response.data[0]
        assert "invite_link" not in response.data[0]


@pytest.mark.contract
@pytest.mark.django_db
class TestSignInMarksEmailVerified:
    @pytest.mark.parametrize("provider", ["magic-code", "google"])
    def test_email_code_or_oauth_sign_in_verifies_a_returning_user(self, invitee, provider):
        _complete_sign_in("email", is_password_autoset=False)
        invitee.refresh_from_db()
        assert invitee.is_email_verified is False

        _complete_sign_in(provider, is_password_autoset=True)
        invitee.refresh_from_db()
        assert invitee.is_email_verified is True
