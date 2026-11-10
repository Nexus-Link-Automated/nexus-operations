# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Changing one date is checked against the other, stored date.

Before, the start and end were only compared when both were sent, so changing one
of them could store an end before the start. A cycle date sent on its own also
skipped the project's timezone in the app.
"""

from datetime import date, datetime, timedelta

import pytest
import pytz
from django.utils import timezone
from rest_framework import status

from plane.celery import app as celery_app
from plane.db.models import Cycle, Issue, Module, Project, ProjectMember
from plane.utils.timezone_converter import convert_to_utc


@pytest.fixture(autouse=True)
def celery_eager():
    """Run background tasks in-process; there is no broker in the test stack."""
    eager, propagates = celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = True, False
    yield
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = eager, propagates


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(
        name="Dates",
        identifier="DATE",
        workspace=workspace,
        created_by=create_user,
        cycle_view=True,
        module_view=True,
        timezone="Asia/Kolkata",
    )
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def issue(project, workspace, create_user):
    return Issue.objects.create(
        name="Dated",
        project=project,
        workspace=workspace,
        start_date=date(2030, 6, 10),
        target_date=date(2030, 6, 20),
        created_by=create_user,
    )


@pytest.fixture
def module(project, workspace):
    return Module.objects.create(
        name="Dated", project=project, workspace=workspace, start_date=date(2030, 6, 10), target_date=date(2030, 6, 20)
    )


@pytest.fixture
def cycle(project, workspace, create_user):
    return Cycle.objects.create(
        name="Dated",
        project=project,
        workspace=workspace,
        owned_by=create_user,
        start_date=convert_to_utc("2030-06-10", project.id, is_start_date=True),
        end_date=convert_to_utc("2030-06-20", project.id),
    )


def app_url(workspace, project, kind, obj):
    return f"/api/workspaces/{workspace.slug}/projects/{project.id}/{kind}/{obj.id}/"


def api_url(workspace, project, kind, obj):
    return f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/{kind}/{obj.id}/"


@pytest.mark.contract
@pytest.mark.django_db
class TestAppSingleDateUpdates:
    @pytest.mark.parametrize("change", [{"target_date": "2030-06-01"}, {"start_date": "2030-06-25"}])
    def test_issue_refuses_a_lone_date_that_inverts_the_range(self, session_client, workspace, project, issue, change):
        response = session_client.patch(app_url(workspace, project, "issues", issue), change, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        issue.refresh_from_db()
        assert (issue.start_date, issue.target_date) == (date(2030, 6, 10), date(2030, 6, 20))

    def test_issue_accepts_a_lone_date_inside_the_range(self, session_client, workspace, project, issue):
        response = session_client.patch(
            app_url(workspace, project, "issues", issue), {"target_date": "2030-06-12"}, format="json"
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        issue.refresh_from_db()
        assert issue.target_date == date(2030, 6, 12)

    def test_issue_already_out_of_order_can_still_be_renamed(self, session_client, workspace, project, issue):
        Issue.objects.filter(pk=issue.pk).update(start_date=date(2030, 6, 25))
        response = session_client.patch(
            app_url(workspace, project, "issues", issue), {"name": "Renamed"}, format="json"
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT

    def test_module_refuses_a_lone_date_that_inverts_the_range(self, session_client, workspace, project, module):
        response = session_client.patch(
            app_url(workspace, project, "modules", module), {"target_date": "2030-06-01"}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        module.refresh_from_db()
        assert module.target_date == date(2030, 6, 20)

    def test_cycle_refuses_a_lone_date_that_inverts_the_range(self, session_client, workspace, project, cycle):
        stored = cycle.end_date
        response = session_client.patch(
            app_url(workspace, project, "cycles", cycle), {"end_date": "2030-06-05"}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        cycle.refresh_from_db()
        assert cycle.end_date == stored

    def test_cycle_lone_dates_use_the_project_timezone(self, session_client, workspace, project, cycle):
        url = app_url(workspace, project, "cycles", cycle)
        assert session_client.patch(url, {"end_date": "2030-06-25"}, format="json").status_code == status.HTTP_200_OK
        assert session_client.patch(url, {"start_date": "2030-06-12"}, format="json").status_code == status.HTTP_200_OK

        cycle.refresh_from_db()
        kolkata = pytz.timezone("Asia/Kolkata")
        assert cycle.start_date == kolkata.localize(datetime(2030, 6, 12, 0, 0, 1))
        assert cycle.end_date == kolkata.localize(datetime(2030, 6, 25, 23, 59))


@pytest.mark.contract
@pytest.mark.django_db
class TestApiSingleDateUpdates:
    def test_work_item_refuses_a_lone_date_that_inverts_the_range(self, api_key_client, workspace, project, issue):
        response = api_key_client.patch(
            api_url(workspace, project, "work-items", issue), {"target_date": "2030-06-01"}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        issue.refresh_from_db()
        assert issue.target_date == date(2030, 6, 20)

    def test_module_refuses_a_lone_date_that_inverts_the_range(self, api_key_client, workspace, project, module):
        response = api_key_client.patch(
            api_url(workspace, project, "modules", module), {"start_date": "2030-06-25"}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        module.refresh_from_db()
        assert module.start_date == date(2030, 6, 10)

    def test_cycle_refuses_a_lone_date_that_inverts_the_range(self, api_key_client, workspace, project, cycle):
        stored = cycle.end_date
        response = api_key_client.patch(
            api_url(workspace, project, "cycles", cycle), {"end_date": "2030-06-05"}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        cycle.refresh_from_db()
        assert cycle.end_date == stored


@pytest.mark.contract
@pytest.mark.django_db
class TestEndingACycleNow:
    """How the MCP completes a cycle: a PATCH of end_date alone to a UTC instant just past."""

    def test_a_started_cycle_ends_at_the_instant_sent(self, api_key_client, workspace, project, cycle):
        Cycle.objects.filter(pk=cycle.pk).update(start_date=timezone.now() - timedelta(days=1))
        ended = timezone.now() - timedelta(seconds=5)
        url = api_url(workspace, project, "cycles", cycle)

        response = api_key_client.patch(url, {"end_date": ended.isoformat()}, format="json")

        assert response.status_code == status.HTTP_200_OK, response.data
        cycle.refresh_from_db()
        assert cycle.end_date == ended
        assert api_key_client.post(f"{url}archive/").status_code == status.HTTP_204_NO_CONTENT

    def test_a_cycle_that_has_not_started_cannot_be_ended(self, api_key_client, workspace, project, cycle):
        """Ending it now would store an end before its start, so it is refused and left as it was."""
        stored = (cycle.start_date, cycle.end_date)
        ended = timezone.now() - timedelta(seconds=5)

        response = api_key_client.patch(
            api_url(workspace, project, "cycles", cycle), {"end_date": ended.isoformat()}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        cycle.refresh_from_db()
        assert (cycle.start_date, cycle.end_date) == stored
