# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Cycle and module detail endpoints load their row only as often as the response needs it.

Each extra load of these querysets repeats the annotated query and every prefetch, so the
tests count the queries on the row's own table and on the table its prefetch reads.
"""

from datetime import date, timedelta
from unittest import mock

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueLabel,
    Label,
    Module,
    ModuleIssue,
    ModuleLink,
    Project,
    ProjectMember,
)

START = date(2026, 1, 1)
END = START + timedelta(days=6)


@pytest.fixture
def setup(db, workspace, create_user):
    project = Project.objects.create(name="A", identifier="PA", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    issue = Issue.objects.create(name="A1", workspace=workspace, project=project)
    IssueAssignee.objects.create(issue=issue, assignee=create_user, project=project, workspace=workspace)
    label = Label.objects.create(name="Bug", project=project, workspace=workspace)
    IssueLabel.objects.create(issue=issue, label=label, project=project, workspace=workspace)
    return {"project": project, "issue": issue, "owner": create_user}


def make_cycle(workspace, setup):
    cycle = Cycle.objects.create(
        name="C1",
        project=setup["project"],
        workspace=workspace,
        owned_by=setup["owner"],
        start_date=timezone.now() - timedelta(days=1),
        end_date=timezone.now() + timedelta(days=1),
    )
    CycleIssue.objects.create(cycle=cycle, issue=setup["issue"], project=setup["project"], workspace=workspace)
    return cycle


def make_module(workspace, setup, **fields):
    module = Module.objects.create(
        name="M1", project=setup["project"], workspace=workspace, start_date=START, target_date=END, **fields
    )
    ModuleIssue.objects.create(module=module, issue=setup["issue"], project=setup["project"], workspace=workspace)
    ModuleLink.objects.create(
        module=module, url="https://example.com", title="Spec", project=setup["project"], workspace=workspace
    )
    return module


def project_url(workspace, setup):
    return f"/api/workspaces/{workspace.slug}/projects/{setup['project'].id}"


def get_with_queries(client, url):
    with CaptureQueriesContext(connection) as context:
        response = client.get(url)
    return response, [query["sql"] for query in context.captured_queries]


def queries_on(model, statements):
    table = model._meta.db_table
    return [sql for sql in statements if f'FROM "{table}"' in sql]


@pytest.mark.contract
@pytest.mark.django_db
@mock.patch("plane.app.views.cycle.base.recent_visited_task")
def test_cycle_retrieve_loads_the_cycle_once_without_prefetching(
    recent_visited_task, session_client, workspace, create_user, setup
):
    cycle = make_cycle(workspace, setup)

    response, statements = get_with_queries(session_client, f"{project_url(workspace, setup)}/cycles/{cycle.id}/")

    assert response.status_code == status.HTTP_200_OK
    assert str(response.data["id"]) == str(cycle.id)
    assert response.data["total_issues"] == 1
    assert [str(user_id) for user_id in response.data["assignee_ids"]] == [str(create_user.id)]
    assert len(queries_on(Cycle, statements)) == 1
    assert queries_on(CycleIssue, statements) == []


@pytest.mark.contract
@pytest.mark.django_db
@mock.patch("plane.app.views.module.base.recent_visited_task")
def test_module_retrieve_loads_the_module_once(recent_visited_task, session_client, workspace, setup):
    module = make_module(workspace, setup)

    response, statements = get_with_queries(session_client, f"{project_url(workspace, setup)}/modules/{module.id}/")

    assert response.status_code == status.HTTP_200_OK
    assert str(response.data["id"]) == str(module.id)
    assert response.data["total_issues"] == 1
    assert [link["title"] for link in response.data["link_module"]] == ["Spec"]
    assert str(START) in response.data["distribution"]["completion_chart"]
    # The exists() check plus one fetch of the row.
    assert len(queries_on(Module, statements)) == 2
    assert len(queries_on(ModuleLink, statements)) == 1


@pytest.mark.contract
@pytest.mark.django_db
def test_archived_module_retrieve_loads_the_module_once(session_client, workspace, setup):
    module = make_module(workspace, setup, archived_at=timezone.now())

    response, statements = get_with_queries(
        session_client, f"{project_url(workspace, setup)}/archived-modules/{module.id}/"
    )

    assert response.status_code == status.HTTP_200_OK
    assert str(response.data["id"]) == str(module.id)
    assert response.data["total_issues"] == 1
    assert [link["title"] for link in response.data["link_module"]] == ["Spec"]
    assert str(START) in response.data["distribution"]["completion_chart"]
    assert len(queries_on(Module, statements)) == 1
    assert len(queries_on(ModuleLink, statements)) == 1
