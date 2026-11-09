# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Auto-close only uses a state from the project whose work items it closes."""

from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone

from plane.bgtasks.issue_automation_task import close_old_issues
from plane.db.models import Issue, Project, State

pytestmark = pytest.mark.unit

TASK = "plane.bgtasks.issue_automation_task"


@pytest.fixture(autouse=True)
def issue_activity():
    with mock.patch(f"{TASK}.issue_activity") as patched:
        yield patched


@pytest.fixture
def make_project(db, workspace, create_user):
    def make(identifier, close_in=1):
        return Project.objects.create(
            name=identifier, identifier=identifier, workspace=workspace, created_by=create_user, close_in=close_in
        )

    return make


def _state(project, group, name=None, first=False):
    state = State.objects.create(name=name or group, project=project, workspace=project.workspace, group=group)
    if first:
        # Sorts ahead of every other project's states.
        State.objects.filter(pk=state.pk).update(sequence=1)
    return state


def _stale_issue(project, state):
    issue = Issue.objects.create(name="Old work", project=project, workspace=project.workspace, state=state)
    Issue.objects.filter(pk=issue.pk).update(updated_at=timezone.now() - timedelta(days=60))
    return issue


def test_uses_the_projects_own_cancelled_state_when_none_is_configured(make_project):
    other_project = make_project("OTH", close_in=0)
    _state(other_project, "cancelled", first=True)

    project = make_project("OWN")
    own_cancelled = _state(project, "cancelled")
    unconfigured = _stale_issue(project, _state(project, "backlog"))

    configured_project = make_project("CFG")
    configured_state = _state(configured_project, "cancelled", name="Dropped")
    Project.objects.filter(pk=configured_project.pk).update(default_state=configured_state)
    configured = _stale_issue(configured_project, _state(configured_project, "started"))

    close_old_issues()

    unconfigured.refresh_from_db()
    configured.refresh_from_db()
    assert unconfigured.state_id == own_cancelled.id
    assert configured.state_id == configured_state.id


def test_project_without_a_cancelled_state_is_skipped_and_logged(make_project, issue_activity):
    project = make_project("NON")
    backlog = _state(project, "backlog")
    skipped = _stale_issue(project, backlog)

    other_project = make_project("OTH")
    other_cancelled = _state(other_project, "cancelled", first=True)
    closed = _stale_issue(other_project, _state(other_project, "backlog"))

    with mock.patch(f"{TASK}.logger") as logger:
        close_old_issues()

    skipped.refresh_from_db()
    closed.refresh_from_db()
    assert skipped.state_id == backlog.id
    assert closed.state_id == other_cancelled.id

    logger.warning.assert_called_once()
    assert project.id in logger.warning.call_args.args
    assert [call.kwargs["issue_id"] for call in issue_activity.delay.call_args_list] == [closed.id]
