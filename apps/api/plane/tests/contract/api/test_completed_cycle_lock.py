# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A completed cycle can only have its sort order changed through the external API.

The view narrowed the request to ``sort_order`` and then validated the full request,
so a request that also carried ``sort_order`` could still rename or re-date a
completed cycle. Ending a running cycle by patching its ``end_date``, as the MCP
``cycle complete`` action does, must keep working.
"""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import Cycle, Project, ProjectMember


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(
        name="Lock Project", identifier="LCK", workspace=workspace, created_by=create_user, cycle_view=True
    )
    ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)
    return project


def _cycle(project, user, start, end):
    return Cycle.objects.create(
        name="Sprint",
        project=project,
        workspace=project.workspace,
        owned_by=user,
        start_date=start,
        end_date=end,
        sort_order=100,
    )


@pytest.fixture
def completed(project, create_user):
    now = timezone.now()
    return _cycle(project, create_user, now - timedelta(days=14), now - timedelta(days=1))


@pytest.fixture
def running(project, create_user):
    now = timezone.now()
    return _cycle(project, create_user, now - timedelta(days=3), now + timedelta(days=4))


def _url(workspace, project, cycle):
    return f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/cycles/{cycle.id}/"


@pytest.mark.contract
class TestCompletedCycleLock:
    @pytest.mark.django_db
    def test_only_sort_order_changes_on_a_completed_cycle(self, api_key_client, workspace, project, completed):
        end_date = completed.end_date
        response = api_key_client.patch(
            _url(workspace, project, completed),
            {"name": "Renamed", "end_date": (timezone.now() + timedelta(days=30)).isoformat(), "sort_order": 5},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        completed.refresh_from_db()
        assert (completed.name, completed.end_date, completed.sort_order) == ("Sprint", end_date, 5)

    @pytest.mark.django_db
    def test_other_edits_to_a_completed_cycle_are_refused(self, api_key_client, workspace, project, completed):
        response = api_key_client.patch(_url(workspace, project, completed), {"name": "Renamed"}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        completed.refresh_from_db()
        assert completed.name == "Sprint"

    @pytest.mark.django_db
    def test_sort_order_can_be_set_on_a_running_cycle(self, api_key_client, workspace, project, running):
        response = api_key_client.patch(_url(workspace, project, running), {"sort_order": 7}, format="json")

        assert response.status_code == status.HTTP_200_OK
        running.refresh_from_db()
        assert running.sort_order == 7

    @pytest.mark.django_db
    def test_a_running_cycle_can_still_be_ended_by_its_end_date(self, api_key_client, workspace, project, running):
        ended = timezone.now() - timedelta(seconds=5)
        url = _url(workspace, project, running)

        response = api_key_client.patch(url, {"end_date": ended.isoformat()}, format="json")

        assert response.status_code == status.HTTP_200_OK
        running.refresh_from_db()
        assert running.end_date == ended
        # Once ended it is locked.
        later = api_key_client.patch(url, {"end_date": timezone.now().isoformat()}, format="json")
        assert later.status_code == status.HTTP_400_BAD_REQUEST
