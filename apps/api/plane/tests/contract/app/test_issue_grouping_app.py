# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Grouped work-item lists.

Removing an assignee, label or module soft-deletes its link row, so these run
against real joins: an item whose links are all soft-deleted belongs in the
"None" group, each item carries its complete ID lists whichever groups fit on
the page, and date and creator grouping works on every list endpoint.
"""

from datetime import date
from unittest import mock
from uuid import uuid4

import pytest
from rest_framework import status

from plane.db.models import (
    Cycle,
    CycleIssue,
    DeployBoard,
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

ASSIGNEES = "assignees__id"
LABELS = "labels__id"
MODULES = "issue_module__module_id"
ID_FIELDS = {ASSIGNEES: "assignee_ids", LABELS: "label_ids", MODULES: "module_ids"}

TARGET_DATE = date(2026, 3, 1)
START_DATE = date(2026, 2, 1)


class Board:
    """A project plus helpers to attach assignees, labels and modules to its work items."""

    def __init__(self, workspace, user):
        self.workspace = workspace
        self.user = user
        self.project = Project.objects.create(name="Grouping", identifier="GRP", workspace=workspace, created_by=user)
        ProjectMember.objects.create(project=self.project, member=user, workspace=workspace, role=20)
        self.state = State.objects.create(name="Todo", project=self.project, group="backlog", default=True)
        self.base_url = f"/api/workspaces/{workspace.slug}/projects/{self.project.id}"
        self.issues_url = f"{self.base_url}/issues/"

    def issue(self, name, **fields):
        issue = Issue(name=name, workspace=self.workspace, project=self.project, state=self.state, **fields)
        issue.save(created_by_id=self.user.id)
        return issue

    def new_value(self, group_by, name):
        if group_by == ASSIGNEES:
            unique = uuid4().hex[:8]
            user = User.objects.create(email=f"{name}-{unique}@plane.so", username=f"{name}_{unique}")
            WorkspaceMember.objects.create(workspace=self.workspace, member=user, role=15)
            ProjectMember.objects.create(project=self.project, member=user, workspace=self.workspace, role=15)
            return user
        model = Label if group_by == LABELS else Module
        return model.objects.create(name=name, project=self.project, workspace=self.workspace)

    def link(self, group_by, issue, value):
        common = {"issue": issue, "project": self.project, "workspace": self.workspace}
        if group_by == ASSIGNEES:
            return IssueAssignee.objects.create(assignee=value, **common)
        if group_by == LABELS:
            return IssueLabel.objects.create(label=value, **common)
        return ModuleIssue.objects.create(module=value, **common)

    def remove(self, link):
        """Soft-delete a link the way the work item serializer does."""
        type(link).objects.filter(pk=link.pk).delete()


@pytest.fixture
def board(db, workspace, create_user):
    return Board(workspace, create_user)


@pytest.fixture(autouse=True)
def recent_visits():
    with mock.patch("plane.app.views.issue.base.recent_visited_task"):
        yield


def names(group):
    return sorted(item["name"] for item in group["results"])


def id_set(values):
    return {str(value.id) for value in values}


def returned_ids(item, group_by):
    return {str(value) for value in item[ID_FIELDS[group_by]]}


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("group_by", [ASSIGNEES, LABELS, MODULES])
def test_removed_values_put_work_item_in_none_group(session_client, board, group_by):
    kept = board.new_value(group_by, "kept")
    dropped = board.new_value(group_by, "dropped")

    board.issue("never")

    removed = board.issue("removed")
    board.remove(board.link(group_by, removed, kept))
    board.remove(board.link(group_by, removed, dropped))

    mixed = board.issue("mixed")
    board.link(group_by, mixed, kept)
    board.remove(board.link(group_by, mixed, dropped))

    re_added = board.issue("re-added")
    board.remove(board.link(group_by, re_added, kept))
    board.link(group_by, re_added, kept)

    response = session_client.get(board.issues_url, {"group_by": group_by})

    assert response.status_code == status.HTTP_200_OK
    results = response.data["results"]
    # Each is listed once, whatever number of soft-deleted links it has
    assert names(results["None"]) == ["never", "removed"]
    assert results["None"]["total_results"] == 2
    assert all(returned_ids(item, group_by) == set() for item in results["None"]["results"])
    assert names(results[str(kept.id)]) == ["mixed", "re-added"]
    assert str(dropped.id) not in results


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("group_by", [ASSIGNEES, LABELS, MODULES])
def test_removed_values_reach_none_group_when_sub_grouped(session_client, board, group_by):
    value = board.new_value(group_by, "value")
    removed = board.issue("removed", priority="high")
    board.remove(board.link(group_by, removed, value))
    board.link(group_by, board.issue("live", priority="high"), value)

    as_group = session_client.get(board.issues_url, {"group_by": group_by, "sub_group_by": "priority"})
    as_sub_group = session_client.get(board.issues_url, {"group_by": "priority", "sub_group_by": group_by})

    assert as_group.status_code == status.HTTP_200_OK
    groups = as_group.data["results"]
    assert names(groups["None"]["results"]["high"]) == ["removed"]
    assert names(groups[str(value.id)]["results"]["high"]) == ["live"]

    assert as_sub_group.status_code == status.HTTP_200_OK
    sub_groups = as_sub_group.data["results"]["high"]["results"]
    assert names(sub_groups["None"]) == ["removed"]
    assert names(sub_groups[str(value.id)]) == ["live"]


@pytest.mark.contract
@pytest.mark.django_db
def test_removed_value_on_one_of_two_grouped_relations(session_client, board):
    label = board.new_value(LABELS, "label")
    assignee = board.new_value(ASSIGNEES, "assignee")
    item = board.issue("item")
    board.link(LABELS, item, label)
    board.remove(board.link(ASSIGNEES, item, assignee))

    response = session_client.get(board.issues_url, {"group_by": LABELS, "sub_group_by": ASSIGNEES})

    assert response.status_code == status.HTTP_200_OK
    assert names(response.data["results"][str(label.id)]["results"]["None"]) == ["item"]


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize(
    "group_by, order_by",
    [
        (ASSIGNEES, "assignees__first_name"),
        (LABELS, "-labels__name"),
        (MODULES, "issue_module__module__name"),
        (LABELS, "priority"),
        (MODULES, "state__group"),
    ],
)
def test_removed_values_reach_none_group_with_each_ordering(session_client, board, group_by, order_by):
    value = board.new_value(group_by, "value")
    removed = board.issue("removed")
    board.remove(board.link(group_by, removed, value))
    board.link(group_by, board.issue("live"), value)

    response = session_client.get(board.issues_url, {"group_by": group_by, "order_by": order_by})

    assert response.status_code == status.HTTP_200_OK
    results = response.data["results"]
    assert names(results["None"]) == ["removed"]
    assert names(results[str(value.id)]) == ["live"]


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize(
    "scope, group_by",
    [("cycle", ASSIGNEES), ("cycle", LABELS), ("cycle", MODULES), ("module", ASSIGNEES), ("module", LABELS)],
)
def test_removed_values_reach_none_group_in_cycle_and_module_lists(session_client, board, scope, group_by):
    common = {"project": board.project, "workspace": board.workspace}
    if scope == "cycle":
        container = Cycle.objects.create(name="Cycle", owned_by=board.user, **common)
        url = f"{board.base_url}/cycles/{container.id}/cycle-issues/"
    else:
        container = Module.objects.create(name="Module", **common)
        url = f"{board.base_url}/modules/{container.id}/issues/"

    value = board.new_value(group_by, "value")
    removed = board.issue("removed")
    board.remove(board.link(group_by, removed, value))
    if scope == "cycle":
        CycleIssue.objects.create(cycle=container, issue=removed, **common)
    else:
        ModuleIssue.objects.create(module=container, issue=removed, **common)

    response = session_client.get(url, {"group_by": group_by})

    assert response.status_code == status.HTTP_200_OK
    assert names(response.data["results"]["None"]) == ["removed"]


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("group_by", [ASSIGNEES, LABELS, MODULES])
def test_grouped_page_returns_every_value_of_a_work_item(session_client, board, group_by):
    first = board.new_value(group_by, "first")
    second = board.new_value(group_by, "second")
    removed = board.new_value(group_by, "removed")

    multi = board.issue("multi")
    board.link(group_by, multi, first)
    board.link(group_by, multi, second)
    board.remove(board.link(group_by, multi, removed))
    # Newer than "multi", so with one row per group it takes the only slot in `second`
    board.link(group_by, board.issue("filler"), second)

    response = session_client.get(board.issues_url, {"group_by": group_by, "order_by": "-sequence_id", "per_page": 1})

    assert response.status_code == status.HTTP_200_OK
    results = response.data["results"]
    assert names(results[str(second.id)]) == ["filler"]
    [item] = results[str(first.id)]["results"]
    assert item["name"] == "multi"
    assert returned_ids(item, group_by) == id_set([first, second])


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("group_by", [ASSIGNEES, LABELS, MODULES])
def test_sub_grouped_page_returns_every_value_of_a_work_item(session_client, board, group_by):
    first = board.new_value(group_by, "first")
    second = board.new_value(group_by, "second")

    multi = board.issue("multi", priority="high")
    board.link(group_by, multi, first)
    board.link(group_by, multi, second)
    board.link(group_by, board.issue("filler", priority="high"), second)

    as_group = session_client.get(
        board.issues_url, {"group_by": group_by, "sub_group_by": "priority", "order_by": "-sequence_id", "per_page": 1}
    )
    as_sub_group = session_client.get(
        board.issues_url, {"group_by": "priority", "sub_group_by": group_by, "order_by": "-sequence_id", "per_page": 1}
    )

    assert as_group.status_code == status.HTTP_200_OK
    [item] = as_group.data["results"][str(first.id)]["results"]["high"]["results"]
    assert returned_ids(item, group_by) == id_set([first, second])

    assert as_sub_group.status_code == status.HTTP_200_OK
    [item] = as_sub_group.data["results"]["high"]["results"][str(first.id)]["results"]
    assert returned_ids(item, group_by) == id_set([first, second])


@pytest.mark.contract
@pytest.mark.django_db
def test_page_grouped_by_two_relations_returns_every_value_of_both(session_client, board):
    label_a, label_b = board.new_value(LABELS, "a"), board.new_value(LABELS, "b")
    assignee_x, assignee_y = board.new_value(ASSIGNEES, "x"), board.new_value(ASSIGNEES, "y")

    multi = board.issue("multi")
    for label in (label_a, label_b):
        board.link(LABELS, multi, label)
    for assignee in (assignee_x, assignee_y):
        board.link(ASSIGNEES, multi, assignee)

    # Newer rows take the only slot in every label/assignee pair except (a, x)
    for label, assignee in ((label_a, assignee_y), (label_b, assignee_x), (label_b, assignee_y)):
        filler = board.issue("filler")
        board.link(LABELS, filler, label)
        board.link(ASSIGNEES, filler, assignee)

    response = session_client.get(
        board.issues_url, {"group_by": LABELS, "sub_group_by": ASSIGNEES, "order_by": "-sequence_id", "per_page": 1}
    )

    assert response.status_code == status.HTTP_200_OK
    [item] = response.data["results"][str(label_a.id)]["results"][str(assignee_x.id)]["results"]
    assert item["name"] == "multi"
    assert returned_ids(item, LABELS) == id_set([label_a, label_b])
    assert returned_ids(item, ASSIGNEES) == id_set([assignee_x, assignee_y])


def _assert_date_or_creator_grouping(client, url, board, field):
    """Group, sub-group and read back the dated and undated work items."""
    as_group = client.get(url, {"group_by": field})
    as_group_with_sub = client.get(url, {"group_by": field, "sub_group_by": "priority"})
    as_sub_group = client.get(url, {"group_by": "priority", "sub_group_by": field})

    assert as_group.status_code == status.HTTP_200_OK
    assert as_group_with_sub.status_code == status.HTTP_200_OK
    assert as_sub_group.status_code == status.HTTP_200_OK

    if field == "created_by":
        assert names(as_group.data["results"][str(board.user.id)]) == ["dated", "undated"]
        return

    key = str(TARGET_DATE if field == "target_date" else START_DATE)
    assert names(as_group.data["results"][key]) == ["dated"]
    assert names(as_group.data["results"]["None"]) == ["undated"]
    assert names(as_group_with_sub.data["results"][key]["results"]["high"]) == ["dated"]
    assert names(as_sub_group.data["results"]["high"]["results"][key]) == ["dated"]


def _dated_issues(board, **fields):
    return [
        board.issue("dated", priority="high", target_date=TARGET_DATE, start_date=START_DATE, **fields),
        board.issue("undated", priority="high", **fields),
    ]


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("field", ["target_date", "start_date", "created_by"])
def test_cycle_list_groups_by_date_and_creator(session_client, board, field):
    common = {"project": board.project, "workspace": board.workspace}
    cycle = Cycle.objects.create(name="Cycle", owned_by=board.user, **common)
    for issue in _dated_issues(board):
        CycleIssue.objects.create(cycle=cycle, issue=issue, **common)

    _assert_date_or_creator_grouping(session_client, f"{board.base_url}/cycles/{cycle.id}/cycle-issues/", board, field)


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("field", ["target_date", "start_date", "created_by"])
def test_archived_list_groups_by_date_and_creator(session_client, board, field):
    _dated_issues(board, archived_at=date(2026, 4, 1))

    _assert_date_or_creator_grouping(session_client, f"{board.base_url}/archived-issues/", board, field)


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("field", ["target_date", "start_date", "created_by"])
def test_public_board_groups_by_date_and_creator(api_client, board, field):
    _dated_issues(board)
    deploy_board = DeployBoard.objects.create(
        entity_identifier=board.project.id, entity_name="project", project=board.project, workspace=board.workspace
    )

    _assert_date_or_creator_grouping(api_client, f"/api/public/anchor/{deploy_board.anchor}/issues/", board, field)
