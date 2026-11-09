# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for who the external API accepts as a cycle owner or module lead.

Both fields take active members of the project in the URL, on create and on update.
"""

from uuid import uuid4

import pytest
from rest_framework import status

from plane.db.models import Cycle, Module, Project, ProjectMember, User, Workspace, WorkspaceMember


def _user(prefix):
    unique_id = uuid4().hex[:8]
    return User.objects.create(email=f"{prefix}-{unique_id}@plane.so", username=f"{prefix}_{unique_id}")


def _project_url(workspace, project):
    return f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(
        name="Owners", identifier="OWN", workspace=workspace, created_by=create_user, cycle_view=True, module_view=True
    )
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20, is_active=True)
    return project


@pytest.fixture
def teammate(db, workspace, project):
    user = _user("teammate")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    ProjectMember.objects.create(project=project, member=user, workspace=workspace, role=15, is_active=True)
    return user


def _former_member(workspace, project):
    user = _user("former")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    ProjectMember.objects.create(project=project, member=user, workspace=workspace, role=15, is_active=False)
    return user


def _workspace_member_outside_project(workspace, project):
    user = _user("outside")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


def _member_of_another_workspace(workspace, project):
    user = _user("elsewhere")
    other_workspace = Workspace.objects.create(name="Elsewhere", owner=user, slug=f"elsewhere-{uuid4().hex[:8]}")
    WorkspaceMember.objects.create(workspace=other_workspace, member=user, role=20)
    return user


@pytest.fixture(params=[_former_member, _workspace_member_outside_project, _member_of_another_workspace])
def ineligible_user(request, db, workspace, project):
    return request.param(workspace, project)


@pytest.mark.contract
@pytest.mark.django_db
class TestCycleOwnerMustBeActiveProjectMember:
    def test_create_accepts_only_an_active_project_member(
        self, api_key_client, workspace, project, teammate, ineligible_user
    ):
        url = f"{_project_url(workspace, project)}/cycles/"

        response = api_key_client.post(url, {"name": "Refused", "owned_by": str(ineligible_user.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert "owned_by" in response.data
        assert not Cycle.objects.filter(project=project, name="Refused").exists()

        response = api_key_client.post(url, {"name": "Accepted", "owned_by": str(teammate.id)}, format="json")
        assert response.status_code == status.HTTP_201_CREATED, response.data
        assert Cycle.objects.get(project=project, name="Accepted").owned_by_id == teammate.id

    def test_update_accepts_only_an_active_project_member(
        self, api_key_client, workspace, project, create_user, teammate, ineligible_user
    ):
        cycle = Cycle.objects.create(name="Sprint", project=project, workspace=workspace, owned_by=create_user)
        url = f"{_project_url(workspace, project)}/cycles/{cycle.id}/"

        response = api_key_client.patch(url, {"owned_by": str(ineligible_user.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert "owned_by" in response.data
        cycle.refresh_from_db()
        assert cycle.owned_by_id == create_user.id

        response = api_key_client.patch(url, {"owned_by": str(teammate.id)}, format="json")
        assert response.status_code == status.HTTP_200_OK, response.data
        cycle.refresh_from_db()
        assert cycle.owned_by_id == teammate.id


@pytest.mark.contract
@pytest.mark.django_db
class TestModuleLeadMustBeActiveProjectMember:
    def test_create_accepts_only_an_active_project_member(
        self, api_key_client, workspace, project, teammate, ineligible_user
    ):
        url = f"{_project_url(workspace, project)}/modules/"

        response = api_key_client.post(url, {"name": "Refused", "lead": str(ineligible_user.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert "lead" in response.data
        assert not Module.objects.filter(project=project, name="Refused").exists()

        response = api_key_client.post(url, {"name": "Accepted", "lead": str(teammate.id)}, format="json")
        assert response.status_code == status.HTTP_201_CREATED, response.data
        assert Module.objects.get(project=project, name="Accepted").lead_id == teammate.id

    def test_update_accepts_only_an_active_project_member(
        self, api_key_client, workspace, project, create_user, teammate, ineligible_user
    ):
        module = Module.objects.create(name="Area", project=project, workspace=workspace, lead=create_user)
        url = f"{_project_url(workspace, project)}/modules/{module.id}/"

        response = api_key_client.patch(url, {"lead": str(ineligible_user.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        assert "lead" in response.data
        module.refresh_from_db()
        assert module.lead_id == create_user.id

        response = api_key_client.patch(url, {"lead": str(teammate.id)}, format="json")
        assert response.status_code == status.HTTP_200_OK, response.data
        module.refresh_from_db()
        assert module.lead_id == teammate.id
