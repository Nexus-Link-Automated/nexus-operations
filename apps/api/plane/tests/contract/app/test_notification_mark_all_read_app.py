# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for ``POST /api/workspaces/<slug>/users/notifications/mark-all-read/``.

The endpoint must mark the matching notifications read with a single ``UPDATE``
and without loading them into memory, so these tests check the SQL the request
ran as well as exactly which rows changed.
"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status

from plane.db.models import (
    Issue,
    IssueAssignee,
    IssueSubscriber,
    Notification,
    Project,
    User,
    Workspace,
    WorkspaceMember,
)


def build_notification(**fields):
    return Notification(
        **{
            "entity_name": "issue",
            "entity_identifier": uuid4(),
            "title": "Notification",
            "sender": "in_app:issue_activities:created",
            **fields,
        }
    )


def mark_all_read(client, slug, body=None):
    """POST to the endpoint, check the unchanged response, and return the SQL it ran."""
    with CaptureQueriesContext(connection) as context:
        response = client.post(f"/api/workspaces/{slug}/users/notifications/mark-all-read/", body or {}, format="json")

    assert response.status_code == status.HTTP_200_OK
    assert response.data == {"message": "Successful"}
    return [query["sql"] for query in context.captured_queries]


def notification_updates(statements):
    return [sql for sql in statements if sql.startswith('UPDATE "notifications"')]


def assert_one_update_and_no_rows_loaded(statements):
    row_selects = [sql for sql in statements if sql.startswith("SELECT") and 'FROM "notifications"' in sql]

    assert row_selects == []
    assert len(notification_updates(statements)) == 1


def names_marked_read(rows):
    """Names of the rows whose ``read_at`` differs from the value they were created with."""
    current = dict(
        Notification.all_objects.filter(pk__in=[row.pk for row in rows.values()]).values_list("pk", "read_at")
    )
    return {name for name, row in rows.items() if current[row.pk] != row.read_at}


@pytest.fixture
def rows(db, create_user, workspace):
    """One notification per way of matching, or failing to match, the endpoint's filters."""
    project = Project.objects.create(name="Notifications", identifier="NOTIF", workspace=workspace)
    subscribed_issue = Issue.objects.create(name="Subscribed", project=project, workspace=workspace)
    assigned_issue = Issue.objects.create(name="Assigned", project=project, workspace=workspace)
    created_issue = Issue.objects.create(name="Created", project=project, workspace=workspace)
    IssueSubscriber.objects.create(issue=subscribed_issue, subscriber=create_user, project=project, workspace=workspace)
    IssueAssignee.objects.create(issue=assigned_issue, assignee=create_user, project=project, workspace=workspace)
    # BaseModel.save() clears created_by when no request user is set, so write it directly.
    Issue.objects.filter(pk=created_issue.pk).update(created_by=create_user)

    suffix = uuid4().hex[:8]
    other_user = User.objects.create(email=f"other-{suffix}@plane.so", username=f"other-{suffix}")
    other_workspace = Workspace.objects.create(name="Other", owner=create_user, slug=f"other-{suffix}")

    yesterday = timezone.now() - timedelta(days=1)
    tomorrow = timezone.now() + timedelta(days=1)

    built = {
        "plain": {},
        "snoozed_future": {"snoozed_till": tomorrow},
        "snoozed_past": {"snoozed_till": yesterday},
        "archived": {"archived_at": yesterday},
        "archived_snoozed": {"archived_at": yesterday, "snoozed_till": tomorrow},
        "subscribed": {"entity_identifier": subscribed_issue.id},
        "assigned": {"entity_identifier": assigned_issue.id},
        "created": {"entity_identifier": created_issue.id},
        # These must never change, whatever the request body says.
        "already_read": {"read_at": yesterday},
        "other_receiver": {"receiver": other_user},
        "other_workspace": {"workspace": other_workspace},
        "soft_deleted": {"deleted_at": yesterday},
    }
    instances = {
        name: build_notification(**{"workspace": workspace, "receiver": create_user, **fields})
        for name, fields in built.items()
    }
    Notification.objects.bulk_create(instances.values())
    return instances


@pytest.mark.contract
class TestMarkAllRead:
    @pytest.mark.parametrize(
        "body, expected",
        [
            ({}, {"plain", "snoozed_future", "subscribed", "assigned", "created"}),
            ({"snoozed": True}, {"snoozed_future", "snoozed_past"}),
            ({"archived": True}, {"archived", "archived_snoozed"}),
            ({"archived": True, "snoozed": True}, {"archived_snoozed"}),
            ({"type": "watching"}, {"subscribed"}),
            ({"type": "assigned"}, {"assigned"}),
            ({"type": "created"}, {"created"}),
        ],
    )
    def test_marks_exactly_the_matching_rows_in_one_update(self, session_client, workspace, rows, body, expected):
        statements = mark_all_read(session_client, workspace.slug, body)

        assert_one_update_and_no_rows_loaded(statements)
        assert names_marked_read(rows) == expected

    def test_created_filter_marks_nothing_for_a_guest(self, session_client, workspace, create_user, rows):
        WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(role=5)

        statements = mark_all_read(session_client, workspace.slug, {"type": "created"})

        assert notification_updates(statements) == []
        assert names_marked_read(rows) == set()

    def test_large_backlog_takes_one_update_and_loads_no_rows(self, session_client, workspace, create_user):
        Notification.objects.bulk_create(
            build_notification(workspace=workspace, receiver=create_user) for _ in range(150)
        )

        statements = mark_all_read(session_client, workspace.slug)

        assert_one_update_and_no_rows_loaded(statements)
        assert not Notification.objects.filter(receiver=create_user, read_at__isnull=True).exists()

    def test_leaves_audit_fields_untouched(self, session_client, workspace, create_user):
        notification = build_notification(workspace=workspace, receiver=create_user)
        notification.save()
        last_month = timezone.now() - timedelta(days=30)
        Notification.objects.filter(pk=notification.pk).update(updated_at=last_month)

        mark_all_read(session_client, workspace.slug)

        notification.refresh_from_db()
        assert notification.read_at is not None
        assert notification.updated_at == last_month
        assert notification.updated_by_id is None
