# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A completed cycle can only have its sort order changed in the app API.

The view narrowed the request to ``sort_order`` and then saved the full request, so a
request that also carried ``sort_order`` could still rename or re-date a completed cycle.
"""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import Cycle, Project, ProjectMember


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Lock Project", identifier="LCK", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20, is_active=True)
    return project


@pytest.fixture
def completed(project, create_user):
    now = timezone.now()
    return Cycle.objects.create(
        name="Sprint",
        project=project,
        workspace=project.workspace,
        owned_by=create_user,
        start_date=now - timedelta(days=14),
        end_date=now - timedelta(days=1),
        sort_order=100,
    )


def _url(workspace, project, cycle):
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/cycles/{cycle.id}/"


@pytest.mark.contract
class TestCompletedCycleLockApp:
    @pytest.mark.django_db
    def test_only_sort_order_changes_on_a_completed_cycle(self, session_client, workspace, project, completed):
        start_date, end_date = completed.start_date, completed.end_date
        response = session_client.patch(
            _url(workspace, project, completed),
            {
                "name": "Renamed",
                "start_date": (timezone.now() + timedelta(days=1)).date().isoformat(),
                "end_date": (timezone.now() + timedelta(days=30)).date().isoformat(),
                "sort_order": 5,
            },
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        completed.refresh_from_db()
        assert (completed.name, completed.start_date, completed.end_date, completed.sort_order) == (
            "Sprint",
            start_date,
            end_date,
            5,
        )

    @pytest.mark.django_db
    def test_other_edits_to_a_completed_cycle_are_refused(self, session_client, workspace, project, completed):
        response = session_client.patch(_url(workspace, project, completed), {"name": "Renamed"}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        completed.refresh_from_db()
        assert completed.name == "Sprint"
