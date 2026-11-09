# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for ``state__group`` on ``GET /api/workspaces/<slug>/issues/``.

``ViewIssueListSerializer`` reads ``instance.state.group`` for every row, so
``WorkspaceViewIssuesViewSet`` has to load the state together with the issues.
Without that, each returned issue costs one more query.
"""

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from plane.db.models import Issue, IssueLabel, Label, Project, ProjectMember, State

URL = "/api/workspaces/{slug}/issues/"

# "labels__name" and "-assignees__first_name" add a GROUP BY to the page query.
ORDERINGS = ["-created_at", "state__group", "-state__group", "priority", "labels__name", "-assignees__first_name"]


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(
        name="Workspace Views Project",
        identifier="WVP",
        workspace=workspace,
        created_by=create_user,
    )
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def states(project):
    return {
        group: State.objects.create(name=group.title(), group=group, project=project)
        for group in ("backlog", "unstarted", "started", "completed", "cancelled")
    }


def _create_issues(project, states, count, start=0):
    groups = list(states)
    return [
        Issue.objects.create(name=f"Issue {index}", project=project, state=states[groups[index % len(groups)]])
        for index in range(start, start + count)
    ]


def _fetch_with_query_count(client, workspace, order_by):
    with CaptureQueriesContext(connection) as queries:
        response = client.get(URL.format(slug=workspace.slug), {"order_by": order_by})
    assert response.status_code == 200
    return response, len(queries.captured_queries)


@pytest.mark.contract
@pytest.mark.django_db
class TestWorkspaceViewIssuesStateGroup:
    @pytest.mark.parametrize("order_by", ORDERINGS)
    def test_query_count_does_not_grow_with_issue_count(self, session_client, workspace, project, states, order_by):
        _create_issues(project, states, 2)
        response, few_issues_queries = _fetch_with_query_count(session_client, workspace, order_by)
        assert len(response.data["results"]) == 2

        _create_issues(project, states, 8, start=2)
        response, many_issues_queries = _fetch_with_query_count(session_client, workspace, order_by)
        assert len(response.data["results"]) == 10

        assert many_issues_queries == few_issues_queries

    @pytest.mark.parametrize("order_by", ORDERINGS)
    def test_each_issue_reports_its_own_state_group(self, session_client, workspace, project, states, order_by):
        issues = {
            group: Issue.objects.create(name=f"In {group}", project=project, state=state)
            for group, state in states.items()
        }
        # Two labels on one issue must not produce two rows for it.
        for name in ("alpha", "beta"):
            label = Label.objects.create(name=name, project=project)
            IssueLabel.objects.create(issue=issues["started"], label=label, project=project)

        response, _ = _fetch_with_query_count(session_client, workspace, order_by)

        assert response.data["total_count"] == len(issues)
        assert len(response.data["results"]) == len(issues)
        rows = {str(row["id"]): row for row in response.data["results"]}
        for group, issue in issues.items():
            row = rows[str(issue.id)]
            assert row["state__group"] == group
            assert str(row["state_id"]) == str(states[group].id)

    def test_issue_without_a_state_reports_no_group(self, session_client, workspace, project, states):
        issue = Issue.objects.create(name="No state", project=project, state=states["backlog"])
        Issue.objects.filter(pk=issue.pk).update(state=None)

        response, _ = _fetch_with_query_count(session_client, workspace, "-created_at")

        row = response.data["results"][0]
        assert str(row["id"]) == str(issue.id)
        assert row["state_id"] is None
        assert row["state__group"] is None

    def test_issue_on_a_soft_deleted_state_keeps_its_group(self, session_client, workspace, project, states):
        issue = Issue.objects.create(name="Deleted state", project=project, state=states["started"])
        State.all_state_objects.filter(pk=states["started"].pk).update(deleted_at=timezone.now())

        response, _ = _fetch_with_query_count(session_client, workspace, "-created_at")

        row = response.data["results"][0]
        assert str(row["id"]) == str(issue.id)
        assert row["state__group"] == "started"
