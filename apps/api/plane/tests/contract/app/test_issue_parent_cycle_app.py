# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A work item cannot be placed under itself or under one of its own sub-work items.

Such a parent forms a loop, and every item in it then disappears from lists that
hide sub-work items. Covers the app and external API updates, the sub-issue endpoint
and the pickers that offer parents and sub-work items.
"""

import pytest
from rest_framework import status

from plane.celery import app as celery_app
from plane.db.models import Issue, Project, ProjectMember


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Loops", identifier="LOOP", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def chain(project, workspace, create_user):
    """top > middle > bottom, plus an unrelated item."""
    top = Issue.objects.create(name="top", project=project, workspace=workspace, created_by=create_user)
    middle = Issue.objects.create(
        name="middle", project=project, workspace=workspace, parent=top, created_by=create_user
    )
    bottom = Issue.objects.create(
        name="bottom", project=project, workspace=workspace, parent=middle, created_by=create_user
    )
    other = Issue.objects.create(name="other", project=project, workspace=workspace, created_by=create_user)
    return top, middle, bottom, other


def app_url(workspace, project, issue):
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/"


def api_url(workspace, project, issue):
    return f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/work-items/{issue.id}/"


@pytest.fixture(autouse=True)
def celery_eager():
    """Run background tasks in-process; there is no broker in the test stack."""
    eager, propagates = celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = True, False
    yield
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = eager, propagates


@pytest.mark.contract
@pytest.mark.django_db
class TestParentLoopsRejected:
    def test_app_update_rejects_itself_as_parent(self, session_client, workspace, project, chain):
        top, *_ = chain
        response = session_client.patch(app_url(workspace, project, top), {"parent_id": str(top.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        top.refresh_from_db()
        assert top.parent_id is None

    def test_app_update_rejects_a_descendant_as_parent(self, session_client, workspace, project, chain):
        top, _, bottom, _ = chain
        response = session_client.patch(app_url(workspace, project, top), {"parent_id": str(bottom.id)}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        top.refresh_from_db()
        assert top.parent_id is None

    def test_app_update_allows_an_unrelated_parent(self, session_client, workspace, project, chain):
        top, _, _, other = chain
        response = session_client.patch(app_url(workspace, project, top), {"parent_id": str(other.id)}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT
        top.refresh_from_db()
        assert top.parent_id == other.id

    def test_api_update_rejects_a_descendant_as_parent(self, api_key_client, workspace, project, chain):
        top, middle, bottom, _ = chain
        for parent in (top, bottom):
            response = api_key_client.patch(api_url(workspace, project, top), {"parent": str(parent.id)}, format="json")
            assert response.status_code == status.HTTP_400_BAD_REQUEST, response.data
        top.refresh_from_db()
        assert top.parent_id is None

    def test_api_update_allows_moving_within_the_tree(self, api_key_client, workspace, project, chain):
        top, _, bottom, _ = chain
        response = api_key_client.patch(api_url(workspace, project, bottom), {"parent": str(top.id)}, format="json")
        assert response.status_code == status.HTTP_200_OK, response.data
        bottom.refresh_from_db()
        assert bottom.parent_id == top.id

    def test_sub_issue_endpoint_rejects_an_ancestor(self, session_client, workspace, project, chain):
        top, _, bottom, other = chain
        url = f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{bottom.id}/sub-issues/"
        response = session_client.post(url, {"sub_issue_ids": [str(other.id), str(top.id)]}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        top.refresh_from_db()
        other.refresh_from_db()
        assert top.parent_id is None
        assert other.parent_id is None

    def test_sub_issue_endpoint_rejects_the_parent_itself(self, session_client, workspace, project, chain):
        _, _, _, other = chain
        url = f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{other.id}/sub-issues/"
        response = session_client.post(url, {"sub_issue_ids": [str(other.id)]}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        other.refresh_from_db()
        assert other.parent_id is None


@pytest.mark.contract
@pytest.mark.django_db
class TestPickersLeaveOutLoops:
    def search(self, client, workspace, project, **params):
        response = client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/search-issues/", params)
        assert response.status_code == status.HTTP_200_OK
        return {str(row["id"]) for row in response.data}

    def test_parent_picker_leaves_out_every_descendant(self, session_client, workspace, project, chain):
        top, middle, bottom, other = chain
        found = self.search(session_client, workspace, project, parent="true", issue_id=str(top.id))
        assert str(middle.id) not in found
        assert str(bottom.id) not in found
        assert str(other.id) in found

    def test_sub_issue_picker_leaves_out_every_ancestor(self, session_client, workspace, project, chain):
        top, _, bottom, other = chain
        found = self.search(session_client, workspace, project, sub_issue="true", issue_id=str(bottom.id))
        assert str(top.id) not in found
        assert str(other.id) in found
