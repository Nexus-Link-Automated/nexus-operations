# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Creating a project with an identifier another project used before.

ProjectIdentifier reserves each identifier, but it kept the old value when a
project's identifier changed, and project creation only checked Project. Reusing
an old identifier then failed at insert, after the project row was already
saved, which left a project with no members and no states.
"""

from unittest import mock

import pytest
from rest_framework import status

from plane.celery import app as celery_app
from plane.db.models import Project, ProjectIdentifier, ProjectMember, State


@pytest.fixture(autouse=True)
def celery_eager():
    """Run background tasks in-process; there is no broker in the test stack."""
    eager, propagates = celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = True, False
    yield
    celery_app.conf.task_always_eager, celery_app.conf.task_eager_propagates = eager, propagates


def projects_url(workspace):
    return f"/api/workspaces/{workspace.slug}/projects/"


def create(client, workspace, name, identifier):
    return client.post(projects_url(workspace), {"name": name, "identifier": identifier}, format="json")


@pytest.mark.contract
@pytest.mark.django_db
class TestProjectIdentifierReuse:
    def test_an_identifier_given_up_by_a_rename_can_be_reused(self, session_client, workspace):
        first = create(session_client, workspace, "First", "OLD")
        assert first.status_code == status.HTTP_201_CREATED
        renamed = session_client.patch(
            f"{projects_url(workspace)}{first.data['id']}/", {"identifier": "NEW"}, format="json"
        )
        assert renamed.status_code == status.HTTP_200_OK
        assert ProjectIdentifier.objects.get(project_id=first.data["id"]).name == "NEW"

        second = create(session_client, workspace, "Second", "OLD")

        assert second.status_code == status.HTTP_201_CREATED, second.data
        assert ProjectMember.objects.filter(project_id=second.data["id"]).exists()
        assert State.objects.filter(project_id=second.data["id"]).count() == 5

    def test_a_reserved_identifier_is_refused_before_anything_is_saved(self, session_client, workspace):
        first = create(session_client, workspace, "First", "KEEP")
        # A reservation left behind by an earlier rename.
        Project.objects.filter(pk=first.data["id"]).update(identifier="MOVED")

        response = create(session_client, workspace, "Second", "KEEP")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "PROJECT_IDENTIFIER_ALREADY_EXIST" in str(response.data)
        assert not Project.objects.filter(name="Second").exists()

    def test_a_rename_to_a_reserved_identifier_is_refused(self, session_client, workspace):
        first = create(session_client, workspace, "First", "AAA")
        second = create(session_client, workspace, "Second", "BBB")
        Project.objects.filter(pk=first.data["id"]).update(identifier="ZZZ")

        response = session_client.patch(
            f"{projects_url(workspace)}{second.data['id']}/", {"identifier": "AAA"}, format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert Project.objects.get(pk=second.data["id"]).identifier == "BBB"

    def test_a_project_keeps_its_own_identifier_on_update(self, session_client, workspace):
        first = create(session_client, workspace, "First", "MINE")
        response = session_client.patch(
            f"{projects_url(workspace)}{first.data['id']}/", {"identifier": "MINE", "name": "Renamed"}, format="json"
        )
        assert response.status_code == status.HTTP_200_OK

    def test_a_failure_part_way_leaves_no_project(self, session_client, workspace):
        with mock.patch("plane.app.views.project.base.State.objects.bulk_create", side_effect=RuntimeError("boom")):
            response = create(session_client, workspace, "Broken", "BRK")

        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
        assert not Project.all_objects.filter(name="Broken").exists()
        assert not ProjectIdentifier.all_objects.filter(name="BRK").exists()
