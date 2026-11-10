# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Removed assignees and labels must not count.

Removing an assignee or a label soft-deletes its link row, and saving a work item's
assignees or labels soft-deletes and recreates every link. Charts, snapshots,
analytics, profiles and exports that joined through ``assignees`` or ``labels``
followed those dead rows, so removed people and labels kept counting and the
counts grew with each save.
"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone

from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    IssueAssignee,
    IssueLabel,
    Label,
    Module,
    ModuleIssue,
    Project,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)
from plane.utils.porters.serializers.issue import IssueExportSerializer


@pytest.fixture
def former(db, workspace):
    """A member who was assigned to the work item and then removed from it."""
    uid = uuid4().hex[:8]
    user = User.objects.create(email=f"former-{uid}@plane.so", username=f"former_{uid}", display_name="former")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    return user


@pytest.fixture
def setup(db, workspace, create_user, former):
    project = Project.objects.create(name="Counts", identifier="CNT", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    ProjectMember.objects.create(project=project, member=former, workspace=workspace, role=15)
    state = State.objects.create(name="Todo", group="unstarted", project=project, workspace=workspace)
    issue = Issue.objects.create(name="Item", project=project, workspace=workspace, state=state)

    def link(model, **kwargs):
        return model.objects.create(issue=issue, project=project, workspace=workspace, **kwargs)

    kept = Label.objects.create(name="kept", project=project, workspace=workspace)
    dropped = Label.objects.create(name="dropped", project=project, workspace=workspace)

    # Two earlier saves left dead copies of the current links, and one person and one label were removed.
    for _ in range(2):
        link(IssueAssignee, assignee=create_user).delete()
        link(IssueLabel, label=kept).delete()
    link(IssueAssignee, assignee=former).delete()
    link(IssueLabel, label=dropped).delete()
    link(IssueAssignee, assignee=create_user)
    link(IssueLabel, label=kept)

    now = timezone.now()
    cycle = Cycle.objects.create(
        name="C",
        project=project,
        workspace=workspace,
        owned_by=create_user,
        start_date=now - timedelta(days=7),
        end_date=now + timedelta(days=7),
    )
    CycleIssue.objects.create(cycle=cycle, issue=issue, project=project, workspace=workspace)
    module = Module.objects.create(name="M", project=project, workspace=workspace)
    ModuleIssue.objects.create(module=module, issue=issue, project=project, workspace=workspace)
    return {"project": project, "issue": issue, "cycle": cycle, "module": module, "kept": kept}


def _assert_only_current(distribution, setup, create_user, count_key="total_issues"):
    assert [(str(row["assignee_id"]), row[count_key]) for row in distribution["assignees"]] == [
        (str(create_user.id), 1)
    ]
    assert [(str(row["label_id"]), row[count_key]) for row in distribution["labels"]] == [(str(setup["kept"].id), 1)]


def _base(workspace, setup):
    return f"/api/workspaces/{workspace.slug}/projects/{setup['project'].id}"


@pytest.mark.contract
class TestDistributionsIgnoreRemovedLinks:
    def test_cycle_analytics(self, session_client, workspace, create_user, setup):
        res = session_client.get(f"{_base(workspace, setup)}/cycles/{setup['cycle'].id}/analytics/?type=issues")
        assert res.status_code == 200
        _assert_only_current(res.data, setup, create_user)

    def test_archived_cycle(self, session_client, workspace, create_user, setup):
        Cycle.objects.filter(pk=setup["cycle"].pk).update(archived_at=timezone.now())
        res = session_client.get(f"{_base(workspace, setup)}/archived-cycles/{setup['cycle'].id}/")
        assert res.status_code == 200
        _assert_only_current(res.data["distribution"], setup, create_user)

    def test_module(self, session_client, workspace, create_user, setup):
        res = session_client.get(f"{_base(workspace, setup)}/modules/{setup['module'].id}/")
        assert res.status_code == 200
        _assert_only_current(res.data["distribution"], setup, create_user)

    def test_archived_module(self, session_client, workspace, create_user, setup):
        Module.objects.filter(pk=setup["module"].pk).update(archived_at=timezone.now())
        res = session_client.get(f"{_base(workspace, setup)}/archived-modules/{setup['module'].id}/")
        assert res.status_code == 200
        _assert_only_current(res.data["distribution"], setup, create_user)

    def test_transfer_snapshot(self, session_client, workspace, create_user, setup):
        now = timezone.now()
        Cycle.objects.filter(pk=setup["cycle"].pk).update(end_date=now - timedelta(days=1))
        target = Cycle.objects.create(
            name="Next",
            project=setup["project"],
            workspace=workspace,
            owned_by=create_user,
            start_date=now,
            end_date=now + timedelta(days=7),
        )
        res = session_client.post(
            f"{_base(workspace, setup)}/cycles/{setup['cycle'].id}/transfer-issues/",
            {"new_cycle_id": str(target.id)},
            format="json",
        )
        assert res.status_code == 200
        setup["cycle"].refresh_from_db()
        _assert_only_current(setup["cycle"].progress_snapshot["distribution"], setup, create_user)


@pytest.mark.contract
class TestAnalyticsIgnoreRemovedLinks:
    def test_project_work_item_stats(self, session_client, workspace, create_user, setup):
        res = session_client.get(f"{_base(workspace, setup)}/advance-analytics-stats/?type=work-items")
        assert res.status_code == 200
        assert [(str(row["assignee_id"]), row["un_started_work_items"]) for row in res.data] == [
            (str(create_user.id), 1)
        ]

    @pytest.mark.parametrize(
        ("axis", "expected"),
        [("assignees__id", lambda user, setup: user.id), ("labels__id", lambda user, setup: setup["kept"].id)],
    )
    def test_workspace_analytics_axis(self, session_client, workspace, create_user, setup, axis, expected):
        res = session_client.get(f"/api/workspaces/{workspace.slug}/analytics/?x_axis={axis}&y_axis=issue_count")
        assert res.status_code == 200
        distribution = res.data["distribution"]
        assert list(distribution) == [str(expected(create_user, setup))]
        assert [row["count"] for row in distribution[str(expected(create_user, setup))]] == [1]

    def test_workspace_analytics_segment(self, session_client, workspace, create_user, setup):
        res = session_client.get(
            f"/api/workspaces/{workspace.slug}/analytics/?x_axis=labels__id&y_axis=issue_count&segment=assignees__id"
        )
        assert res.status_code == 200
        rows = res.data["distribution"][str(setup["kept"].id)]
        assert [(str(row["segment"]), row["count"]) for row in rows] == [(str(create_user.id), 1)]


@pytest.mark.contract
class TestProfileAndExportIgnoreRemovedLinks:
    def _project_row(self, session_client, workspace, setup, user):
        res = session_client.get(f"/api/workspaces/{workspace.slug}/user-profile/{user.id}/")
        assert res.status_code == 200
        return next(row for row in res.data["project_data"] if row["id"] == setup["project"].id)

    def test_profile_counts_current_assignee_once(self, session_client, workspace, create_user, setup):
        row = self._project_row(session_client, workspace, setup, create_user)
        assert (row["assigned_issues"], row["pending_issues"], row["completed_issues"]) == (1, 1, 0)

    def test_profile_ignores_removed_assignee(self, session_client, workspace, former, setup):
        row = self._project_row(session_client, workspace, setup, former)
        assert (row["assigned_issues"], row["pending_issues"]) == (0, 0)

    def test_profile_created_count_is_not_multiplied_by_links(self, session_client, workspace, create_user, setup):
        Issue.objects.filter(pk=setup["issue"].pk).update(created_by=create_user)
        row = self._project_row(session_client, workspace, setup, create_user)
        assert row["created_issues"] == 1

    def test_export_lists_current_assignees_only(self, create_user, setup):
        create_user.first_name, create_user.last_name = "Current", "Person"
        create_user.save()
        assert IssueExportSerializer(setup["issue"]).data["assignees"] == ["Current Person"]
