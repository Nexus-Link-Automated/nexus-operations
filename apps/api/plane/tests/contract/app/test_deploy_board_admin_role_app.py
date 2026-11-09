# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the role needed to manage a project's public board.

Project members and guests keep read access to the board. Creating, changing or
removing it needs a project admin, or a workspace admin who is a member of the
project, which matches what the web app offers.
"""

from uuid import uuid4

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import DeployBoard, Project, ProjectMember, User, WorkspaceMember

ADMIN, MEMBER, GUEST = 20, 15, 5


def _boards_url(slug, project_id):
    return f"/api/workspaces/{slug}/projects/{project_id}/project-deploy-boards/"


def _board_url(slug, project_id, pk):
    return f"{_boards_url(slug, project_id)}{pk}/"


def _client_for(workspace, project, workspace_role, project_role):
    unique_id = uuid4().hex[:8]
    user = User.objects.create(email=f"board-{unique_id}@plane.so", username=f"board_{unique_id}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=workspace_role)
    ProjectMember.objects.create(project=project, member=user, workspace=workspace, role=project_role, is_active=True)
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def project(db, workspace):
    return Project.objects.create(name="Board Project", identifier="BRD", workspace=workspace)


@pytest.fixture
def board(db, workspace, project):
    return DeployBoard.objects.create(
        workspace=workspace, project=project, entity_name="project", entity_identifier=project.id
    )


@pytest.fixture
def member_client(db, workspace, project):
    return _client_for(workspace, project, MEMBER, MEMBER)


@pytest.fixture
def guest_client(db, workspace, project):
    return _client_for(workspace, project, GUEST, GUEST)


@pytest.fixture(params=[(MEMBER, ADMIN), (ADMIN, MEMBER)], ids=["project_admin", "workspace_admin_in_project"])
def manager_client(request, db, workspace, project):
    return _client_for(workspace, project, *request.param)


@pytest.mark.contract
@pytest.mark.django_db
class TestDeployBoardManageRole:
    def test_creating_a_board_needs_a_project_admin(self, member_client, manager_client, workspace, project):
        url = _boards_url(workspace.slug, project.id)
        boards = DeployBoard.objects.filter(entity_name="project", entity_identifier=project.id)

        response = member_client.post(url, {}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
        assert not boards.exists()

        response = manager_client.post(url, {}, format="json")
        assert response.status_code == status.HTTP_200_OK, response.data
        assert boards.exists()

    def test_changing_a_board_needs_a_project_admin(self, member_client, manager_client, workspace, project, board):
        url = _board_url(workspace.slug, project.id, board.id)

        response = member_client.patch(url, {"is_comments_enabled": True}, format="json")
        assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
        board.refresh_from_db()
        assert board.is_comments_enabled is False

        response = manager_client.patch(url, {"is_comments_enabled": True}, format="json")
        assert response.status_code == status.HTTP_200_OK, response.data
        board.refresh_from_db()
        assert board.is_comments_enabled is True

    def test_removing_a_board_needs_a_project_admin(self, member_client, manager_client, workspace, project, board):
        url = _board_url(workspace.slug, project.id, board.id)

        response = member_client.delete(url)
        assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
        assert DeployBoard.objects.filter(pk=board.id).exists()

        response = manager_client.delete(url)
        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
        assert not DeployBoard.objects.filter(pk=board.id).exists()

    def test_members_and_guests_can_read_the_board_but_not_change_it(
        self, member_client, guest_client, workspace, project, board
    ):
        list_url = _boards_url(workspace.slug, project.id)
        detail_url = _board_url(workspace.slug, project.id, board.id)

        for client in (member_client, guest_client):
            response = client.get(list_url)
            assert response.status_code == status.HTTP_200_OK, response.data
            assert str(response.data["id"]) == str(board.id)

            response = client.get(detail_url)
            assert response.status_code == status.HTTP_200_OK, response.data
            assert str(response.data["id"]) == str(board.id)

            response = client.patch(detail_url, {"is_comments_enabled": True}, format="json")
            assert response.status_code == status.HTTP_403_FORBIDDEN, response.data

        board.refresh_from_db()
        assert board.is_comments_enabled is False
