# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the public work item detail endpoint.

The public board does not use the editor's binary description state, so the
endpoint must not return it. Raw bytes are also not JSON serialisable, so
returning them made the request fail for any work item that had them stored.
"""

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import DeployBoard, Issue, Project, State


@pytest.fixture
def published_issue(db, workspace, create_user):
    project = Project.objects.create(
        name="Public Project", identifier="PUB", workspace=workspace, created_by=create_user
    )
    state = State.objects.create(name="Todo", project=project, workspace=workspace, group="backlog", default=True)
    issue = Issue.objects.create(
        name="Public Issue",
        workspace=workspace,
        project=project,
        state=state,
        created_by=create_user,
        description_html="<p>hello</p>",
        description_binary=b"\x01\x02\x00\xffeditor-state",
    )
    deploy_board = DeployBoard.objects.create(
        entity_name="project",
        entity_identifier=project.id,
        project=project,
        workspace=workspace,
    )
    return deploy_board.anchor, issue


@pytest.mark.contract
@pytest.mark.django_db
def test_public_issue_detail_loads_when_binary_description_is_stored(published_issue):
    anchor, issue = published_issue

    response = APIClient().get(f"/api/public/anchor/{anchor}/issues/{issue.id}/")

    assert response.status_code == status.HTTP_200_OK
    body = response.json()
    assert body["id"] == str(issue.id)
    assert body["description_html"] == "<p>hello</p>"
    assert "description_binary" not in body
