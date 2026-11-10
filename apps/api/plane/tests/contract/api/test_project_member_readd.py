# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Adding a project member through the public API (v1) after removing them.

Removal only deactivates the membership row, so adding the person back must
reactivate that row with the requested role instead of failing on the unique
constraint.
"""

import pytest
from rest_framework import status

from plane.db.models import Project, ProjectMember, WorkspaceMember
from plane.tests.factories import UserFactory


def _members_url(slug, project_id, pk=None):
    base = f"/api/v1/workspaces/{slug}/projects/{project_id}/members/"
    return f"{base}{pk}/" if pk else base


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Members", identifier="MEM", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def teammate(db, workspace):
    user = UserFactory(email="teammate@plane.so")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.mark.contract
@pytest.mark.django_db
class TestProjectMemberReadd:
    def test_removed_member_can_be_added_back_with_new_role(self, api_key_client, workspace, project, teammate):
        added = api_key_client.post(
            _members_url(workspace.slug, project.id), {"member": str(teammate.id), "role": 20}, format="json"
        )
        assert added.status_code == status.HTTP_201_CREATED, added.content
        row = ProjectMember.objects.get(project=project, member=teammate)

        removed = api_key_client.delete(_members_url(workspace.slug, project.id, row.id))
        assert removed.status_code == status.HTTP_204_NO_CONTENT, removed.content

        readded = api_key_client.post(
            _members_url(workspace.slug, project.id), {"member": str(teammate.id), "role": 15}, format="json"
        )

        assert readded.status_code == status.HTTP_201_CREATED, readded.content
        assert readded.json()["id"] == str(row.id)
        assert readded.json()["role"] == 15
        rows = ProjectMember.objects.filter(project=project, member=teammate)
        assert rows.count() == 1
        row = rows.get()
        assert row.is_active is True
        assert row.role == 15

    def test_readd_still_caps_a_workspace_guest(self, api_key_client, workspace, project):
        guest = UserFactory(email="guest@plane.so")
        WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)
        ProjectMember.objects.create(project=project, member=guest, workspace=workspace, role=5, is_active=False)

        response = api_key_client.post(
            _members_url(workspace.slug, project.id), {"member": str(guest.id), "role": 20}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.content
        assert ProjectMember.objects.get(project=project, member=guest).is_active is False

    def test_active_member_cannot_be_added_twice(self, api_key_client, workspace, project, teammate):
        ProjectMember.objects.create(project=project, member=teammate, workspace=workspace, role=15)

        response = api_key_client.post(
            _members_url(workspace.slug, project.id), {"member": str(teammate.id), "role": 20}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST, response.content
        assert response.json()["code"] == "USER_ALREADY_MEMBER"
        row = ProjectMember.objects.get(project=project, member=teammate)
        assert row.role == 15
