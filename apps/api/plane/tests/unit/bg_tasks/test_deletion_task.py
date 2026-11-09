# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
hard_delete against real foreign keys. The IssueActivity constraints are deferred to commit,
so these tests need transaction=True: inside a wrapping test transaction they would never fire.
"""

from datetime import timedelta
from types import SimpleNamespace
from unittest import mock

import pytest
from django.db.models import QuerySet
from django.utils import timezone

from plane.bgtasks.deletion_task import hard_delete
from plane.db.models import Cycle, Issue, IssueActivity, IssueComment, Page, Project, State

pytestmark = [pytest.mark.unit, pytest.mark.django_db(transaction=True)]

RETENTION_DAYS = 60
PAST_RETENTION_DAYS = 90
INSIDE_RETENTION_DAYS = 10


@pytest.fixture(autouse=True)
def retention(settings):
    settings.HARD_DELETE_AFTER_DAYS = RETENTION_DAYS


@pytest.fixture
def scope(workspace, create_user):
    project = Project.objects.create(name="Home", identifier="HOME", workspace=workspace)
    state = State.objects.create(
        name="Backlog", color="#000000", group="backlog", default=True, project=project, workspace=workspace
    )
    return SimpleNamespace(user=create_user, workspace=workspace, project=project, state=state)


def _issue(scope, name, **kwargs):
    return Issue.objects.create(
        name=name, project=scope.project, workspace=scope.workspace, state=scope.state, **kwargs
    )


def _comment(scope, issue):
    return IssueComment.objects.create(
        issue=issue, project=scope.project, workspace=scope.workspace, actor=scope.user, comment_html="<p>note</p>"
    )


def _activity(scope, issue, comment=None):
    return IssueActivity.objects.create(
        issue=issue, issue_comment=comment, project=scope.project, workspace=scope.workspace, actor=scope.user
    )


def _soft_delete(row, days_ago):
    type(row).all_objects.filter(pk=row.pk).update(deleted_at=timezone.now() - timedelta(days=days_ago))


def _exists(row):
    return type(row).all_objects.filter(pk=row.pk).exists()


def test_expired_issue_is_purged_and_its_activity_history_is_kept(scope):
    issue = _issue(scope, "Expired")
    comment = _comment(scope, issue)
    issue_activity = _activity(scope, issue)
    comment_activity = _activity(scope, issue, comment=comment)
    _soft_delete(issue, PAST_RETENTION_DAYS)

    hard_delete()

    assert not _exists(issue)
    assert not _exists(comment)
    for activity in (issue_activity, comment_activity):
        activity.refresh_from_db()
        assert activity.issue_id is None
        assert activity.issue_comment_id is None


def test_steps_after_issues_run_once_an_expired_issue_is_purged(scope):
    issue = _issue(scope, "Expired")
    _activity(scope, issue)
    _soft_delete(issue, PAST_RETENTION_DAYS)
    page = Page.objects.create(name="Expired", workspace=scope.workspace, owned_by=scope.user)
    _soft_delete(page, PAST_RETENTION_DAYS)

    hard_delete()

    assert not _exists(page)


def test_rows_not_past_retention_are_left_alone(scope):
    expired = _issue(scope, "Expired")
    _activity(scope, expired)
    _soft_delete(expired, PAST_RETENTION_DAYS)

    recent = _issue(scope, "Inside retention")
    recent_activity = _activity(scope, recent)
    _soft_delete(recent, INSIDE_RETENTION_DAYS)

    live = _issue(scope, "Live")
    live_comment = _comment(scope, live)
    live_activity = _activity(scope, live, comment=live_comment)

    hard_delete()

    assert not _exists(expired)
    assert _exists(recent) and _exists(live) and _exists(live_comment)
    recent_activity.refresh_from_db()
    assert recent_activity.issue_id == recent.id
    live_activity.refresh_from_db()
    assert live_activity.issue_id == live.id
    assert live_activity.issue_comment_id == live_comment.id


def test_sub_issues_not_past_retention_outlive_an_expired_parent(scope):
    parent = _issue(scope, "Bulk deleted parent")
    _activity(scope, parent)

    live_child = _issue(scope, "Live child", parent=parent)
    live_child_activity = _activity(scope, live_child)
    recent_child = _issue(scope, "Child inside retention", parent=parent)
    expired_child = _issue(scope, "Expired child", parent=parent)
    _activity(scope, expired_child)
    _soft_delete(recent_child, INSIDE_RETENTION_DAYS)
    _soft_delete(expired_child, PAST_RETENTION_DAYS)

    # The bulk delete endpoint soft deletes through the queryset, which leaves sub-issues live
    Issue.issue_objects.filter(pk=parent.pk).delete()
    live_child.refresh_from_db()
    assert live_child.deleted_at is None
    _soft_delete(parent, PAST_RETENTION_DAYS)

    hard_delete()

    assert not _exists(parent)
    assert not _exists(expired_child)
    live_child.refresh_from_db()
    assert live_child.deleted_at is None
    assert live_child.parent_id is None
    recent_child.refresh_from_db()
    assert recent_child.parent_id is None
    live_child_activity.refresh_from_db()
    assert live_child_activity.issue_id == live_child.id


def test_expired_comment_on_a_live_issue_is_purged(scope):
    issue = _issue(scope, "Live")
    comment = _comment(scope, issue)
    activity = _activity(scope, issue, comment=comment)
    _soft_delete(comment, PAST_RETENTION_DAYS)

    hard_delete()

    assert not _exists(comment)
    assert _exists(issue)
    activity.refresh_from_db()
    assert activity.issue_id == issue.id
    assert activity.issue_comment_id is None


def test_a_failing_model_does_not_stop_the_later_ones(scope):
    cycle = Cycle.objects.create(name="Expired", project=scope.project, workspace=scope.workspace, owned_by=scope.user)
    _soft_delete(cycle, PAST_RETENTION_DAYS)
    page = Page.objects.create(name="Expired", workspace=scope.workspace, owned_by=scope.user)
    _soft_delete(page, PAST_RETENTION_DAYS)

    real_delete = QuerySet.delete

    def delete(queryset):
        if queryset.model is Cycle:
            raise RuntimeError("cycles cannot be deleted")
        return real_delete(queryset)

    with mock.patch.object(QuerySet, "delete", delete):
        hard_delete()

    assert _exists(cycle)
    assert not _exists(page)
