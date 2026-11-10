# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Creating project email invitations (``ProjectInvitationsViewset.create``).

The endpoint used to fail with a server error before queueing any email.
"""

from unittest import mock

import pytest
from rest_framework import status

from plane.db.models import Project, ProjectMember, ProjectMemberInvite, WorkspaceMember
from plane.tests.factories import UserFactory


def _invites_url(slug, project_id):
    return f"/api/workspaces/{slug}/projects/{project_id}/invitations/"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(
        name="Invite Project", identifier="INV", workspace=workspace, created_by=create_user
    )
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20, is_active=True)
    return project


@pytest.fixture
def web_url(settings):
    settings.WEB_URL = "http://app.test"
    settings.APP_BASE_URL = None
    return settings.WEB_URL


@pytest.mark.contract
@pytest.mark.django_db
class TestCreateProjectInvitation:
    def test_invite_is_created_and_email_queued(self, session_client, workspace, project, create_user, web_url):
        with mock.patch("plane.app.views.project.invite.project_invitation") as task:
            response = session_client.post(
                _invites_url(workspace.slug, project.id),
                {"emails": [{"email": "New.Person@Example.com", "role": 15}]},
                format="json",
            )

        assert response.status_code == status.HTTP_200_OK, response.content
        invite = ProjectMemberInvite.objects.get(project=project)
        assert invite.email == "new.person@example.com"
        assert invite.token
        task.delay.assert_called_once_with(invite.email, project.id, invite.token, web_url, create_user.email)

    def test_role_differing_from_workspace_guest_role_is_rejected(self, session_client, workspace, project, web_url):
        guest = UserFactory(email="guest@plane.so")
        WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)

        with mock.patch("plane.app.views.project.invite.project_invitation") as task:
            response = session_client.post(
                _invites_url(workspace.slug, project.id),
                {"emails": [{"email": "Guest@Plane.so", "role": 20}]},
                format="json",
            )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.content
        assert not ProjectMemberInvite.objects.filter(project=project).exists()
        task.delay.assert_not_called()
