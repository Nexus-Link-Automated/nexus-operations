# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Bulk delete does what deleting each work item on its own does.

Before, it only marked the selected rows deleted: their sub-work items, assignees
and other related records stayed live, and no deletion was recorded in history.
"""

import pytest
from rest_framework import status

from plane.celery import app as celery_app
from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    IssueActivity,
    IssueAssignee,
    Project,
    ProjectMember,
    UserRecentVisit,
)


@pytest.fixture(autouse=True)
def celery_eager():
    """Run background tasks in-process; there is no broker in the test stack."""
    eager, propagates = celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = True, False
    yield
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = eager, propagates


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Bulk", identifier="BULK", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def items(project, workspace, create_user):
    parent = Issue.objects.create(name="parent", project=project, workspace=workspace, created_by=create_user)
    child = Issue.objects.create(
        name="child", project=project, workspace=workspace, parent=parent, created_by=create_user
    )
    kept = Issue.objects.create(name="kept", project=project, workspace=workspace, created_by=create_user)
    IssueAssignee.objects.create(issue=parent, assignee=create_user, project=project, workspace=workspace)
    cycle = Cycle.objects.create(name="C", project=project, workspace=workspace, owned_by=create_user)
    CycleIssue.objects.create(cycle=cycle, issue=parent, project=project, workspace=workspace)
    UserRecentVisit.objects.create(
        user=create_user, workspace=workspace, project=project, entity_name="issue", entity_identifier=parent.id
    )
    return parent, child, kept


@pytest.mark.contract
@pytest.mark.django_db
def test_bulk_delete_cascades_and_records_history(
    session_client, workspace, project, items, create_user, django_capture_on_commit_callbacks
):
    parent, child, kept = items
    url = f"/api/workspaces/{workspace.slug}/projects/{project.id}/bulk-delete-issues/"

    with django_capture_on_commit_callbacks(execute=True):
        response = session_client.delete(url, {"issue_ids": [str(parent.id)]}, format="json")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["message"] == "1 issues were deleted"

    deleted = Issue.all_objects.get(pk=parent.id)
    assert deleted.deleted_at is not None
    assert deleted.updated_at >= deleted.deleted_at
    assert Issue.all_objects.get(pk=child.id).deleted_at is not None, "sub-work item left live"
    assert not IssueAssignee.objects.filter(issue_id=parent.id).exists(), "assignee left live"
    assert not CycleIssue.objects.filter(issue_id=parent.id).exists()
    assert not UserRecentVisit.objects.filter(entity_identifier=parent.id).exists()
    assert IssueActivity.objects.filter(issue_id=parent.id, verb="deleted", actor=create_user).exists()

    assert Issue.objects.get(pk=kept.id).deleted_at is None


@pytest.mark.contract
@pytest.mark.django_db
def test_bulk_delete_ignores_items_from_another_project(
    session_client, workspace, project, create_user, django_capture_on_commit_callbacks
):
    other = Project.objects.create(name="Other", identifier="OTH", workspace=workspace, created_by=create_user)
    foreign = Issue.objects.create(name="foreign", project=other, workspace=workspace, created_by=create_user)
    url = f"/api/workspaces/{workspace.slug}/projects/{project.id}/bulk-delete-issues/"

    with django_capture_on_commit_callbacks(execute=True):
        response = session_client.delete(url, {"issue_ids": [str(foreign.id)]}, format="json")

    assert response.status_code == status.HTTP_200_OK
    assert Issue.objects.get(pk=foreign.id).deleted_at is None
    assert not IssueActivity.objects.filter(issue_id=foreign.id, verb="deleted").exists()
