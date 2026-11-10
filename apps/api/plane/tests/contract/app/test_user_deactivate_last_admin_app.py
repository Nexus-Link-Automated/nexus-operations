# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The only admin of a project or workspace that has other members cannot deactivate their account.

The check counted over the user's own membership rows, so it never saw another
member and always let the account go, leaving those members with no admin.
"""

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.celery import app as celery_app
from plane.db.models import Profile, Project, ProjectMember, User, WorkspaceMember
from plane.tests.factories import UserFactory

ME_URL = "/api/users/me/"


@pytest.fixture(autouse=True)
def celery_eager():
    """Run background tasks in-process; there is no broker in the test stack."""
    eager, propagates = celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = True, False
    yield
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = eager, propagates


@pytest.fixture(autouse=True)
def profile(create_user):
    Profile.objects.get_or_create(user=create_user)


@pytest.fixture
def project(workspace, create_user):
    project = Project.objects.create(name="Admins", identifier="ADM", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


def add_member(workspace, role, project=None):
    user = UserFactory()
    Profile.objects.get_or_create(user=user)
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
    if project is not None:
        ProjectMember.objects.create(project=project, member=user, workspace=workspace, role=role)
    return user


def is_active(user):
    return User.objects.get(pk=user.pk).is_active


@pytest.mark.contract
@pytest.mark.django_db
class TestDeactivateLastAdmin:
    def test_only_project_admin_cannot_deactivate(self, session_client, workspace, project, create_user):
        add_member(workspace, 20)  # another workspace admin, so only the project check applies
        member = add_member(workspace, 15)
        ProjectMember.objects.create(project=project, member=member, workspace=workspace, role=15)

        response = session_client.delete(ME_URL)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "projects" in response.data["error"]
        assert is_active(create_user)
        assert ProjectMember.objects.get(project=project, member=create_user).is_active

    def test_only_workspace_admin_cannot_deactivate(self, session_client, workspace, create_user):
        add_member(workspace, 15)

        response = session_client.delete(ME_URL)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "workspaces" in response.data["error"]
        assert is_active(create_user)
        assert WorkspaceMember.objects.get(workspace=workspace, member=create_user).is_active

    def test_an_inactive_admin_does_not_count(self, session_client, workspace, create_user):
        other = add_member(workspace, 20)
        WorkspaceMember.objects.filter(workspace=workspace, member=other).update(is_active=False)
        add_member(workspace, 15)

        response = session_client.delete(ME_URL)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert is_active(create_user)

    def test_admin_with_another_admin_can_deactivate(self, session_client, workspace, project, create_user):
        add_member(workspace, 20, project=project)
        add_member(workspace, 15, project=project)

        response = session_client.delete(ME_URL)

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not is_active(create_user)
        assert not ProjectMember.objects.get(project=project, member=create_user).is_active
        assert not WorkspaceMember.objects.get(workspace=workspace, member=create_user).is_active

    def test_sole_member_can_deactivate(self, session_client, workspace, project, create_user):
        response = session_client.delete(ME_URL)

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not is_active(create_user)

    def test_member_who_is_not_an_admin_can_deactivate(self, workspace, project):
        add_member(workspace, 20, project=project)
        member = add_member(workspace, 15, project=project)
        client = APIClient()
        client.force_authenticate(user=member)

        response = client.delete(ME_URL)

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not is_active(member)
