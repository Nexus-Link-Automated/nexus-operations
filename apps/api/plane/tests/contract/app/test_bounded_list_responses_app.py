# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the bounds on list responses.

Webhook delivery logs and the notification list without pagination params keep
their plain-array shape, capped at the newest MAX_LIMIT rows, with a warning
when rows are dropped. Global search returns at most 100 rows per entity, as
its issue search does.
"""

import logging
from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import (
    Cycle,
    IssueView,
    Module,
    Notification,
    Page,
    Project,
    ProjectMember,
    ProjectPage,
    WebhookLog,
)
from plane.utils.paginator import MAX_LIMIT

GLOBAL_SEARCH_LIMIT = 100


def _capped_warnings(caplog):
    return [r for r in caplog.records if r.levelno == logging.WARNING and "capped" in r.getMessage()]


def _make_oldest(row):
    """Backdate one row so which row the bound drops is deterministic."""
    type(row).objects.filter(pk=row.pk).update(created_at=timezone.now() - timedelta(days=1))


def _ids(rows):
    return {str(row["id"]) for row in rows}


def _webhook_logs(workspace, webhook_id, count):
    return WebhookLog.objects.bulk_create(
        [WebhookLog(workspace=workspace, webhook=webhook_id, event_type="issue") for _ in range(count)]
    )


def _notifications(workspace, receiver, count):
    return Notification.objects.bulk_create(
        [
            Notification(
                workspace=workspace,
                receiver=receiver,
                entity_name="issue",
                entity_identifier=uuid4(),
                title="Updated",
                sender="in_app:issue_activities:assigned",
            )
            for _ in range(count)
        ]
    )


def _cycles(workspace, project, owner, count):
    return Cycle.objects.bulk_create(
        [Cycle(workspace=workspace, project=project, owned_by=owner, name=f"Cycle {i}") for i in range(count)]
    )


def _modules(workspace, project, _owner, count):
    return Module.objects.bulk_create(
        [Module(workspace=workspace, project=project, name=f"Module {i}") for i in range(count)]
    )


def _pages(workspace, project, owner, count):
    pages = Page.objects.bulk_create(
        [Page(workspace=workspace, owned_by=owner, name=f"Page {i}") for i in range(count)]
    )
    ProjectPage.objects.bulk_create([ProjectPage(workspace=workspace, project=project, page=page) for page in pages])
    return pages


def _views(workspace, project, owner, count):
    # bulk_create skips IssueView.save, which normally fills in query.
    return IssueView.objects.bulk_create(
        [
            IssueView(workspace=workspace, project=project, owned_by=owner, name=f"View {i}", query={})
            for i in range(count)
        ]
    )


SEARCH_ENTITIES = [
    ("cycle", _cycles),
    ("module", _modules),
    ("page", _pages),
    ("issue_view", _views),
]


@pytest.fixture
def search_project(db, workspace, create_user):
    project = Project.objects.create(name="Bounded Search", identifier="BS", workspace=workspace)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.mark.contract
@pytest.mark.django_db
class TestWebhookLogsCap:
    def _get(self, client, workspace, webhook_id):
        return client.get(f"/api/workspaces/{workspace.slug}/webhook-logs/{webhook_id}/")

    def test_over_cap_keeps_newest_rows_as_plain_array_and_logs(self, session_client, workspace, caplog):
        webhook_id = uuid4()
        logs = _webhook_logs(workspace, webhook_id, MAX_LIMIT + 1)
        _make_oldest(logs[0])

        with caplog.at_level(logging.WARNING, logger="plane.api"):
            response = self._get(session_client, workspace, webhook_id)

        assert response.status_code == status.HTTP_200_OK
        rows = response.json()
        assert isinstance(rows, list)
        assert len(rows) == MAX_LIMIT
        assert str(logs[0].id) not in _ids(rows)
        assert _capped_warnings(caplog)

    def test_at_cap_returns_every_row_without_logging(self, session_client, workspace, caplog):
        webhook_id = uuid4()
        _webhook_logs(workspace, webhook_id, MAX_LIMIT)

        with caplog.at_level(logging.WARNING, logger="plane.api"):
            response = self._get(session_client, workspace, webhook_id)

        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == MAX_LIMIT
        assert not _capped_warnings(caplog)


@pytest.mark.contract
@pytest.mark.django_db
class TestNotificationListCap:
    def _url(self, workspace):
        return f"/api/workspaces/{workspace.slug}/users/notifications/"

    # Only a request carrying both params reaches the paginated branch.
    @pytest.mark.parametrize("params", [{}, {"per_page": 10}, {"cursor": "10:0:0"}])
    def test_over_cap_keeps_newest_rows_as_plain_array_and_logs(
        self, session_client, workspace, create_user, caplog, params
    ):
        notifications = _notifications(workspace, create_user, MAX_LIMIT + 1)
        _make_oldest(notifications[0])

        with caplog.at_level(logging.WARNING, logger="plane.api"):
            response = session_client.get(self._url(workspace), params)

        assert response.status_code == status.HTTP_200_OK
        rows = response.json()
        assert isinstance(rows, list)
        assert len(rows) == MAX_LIMIT
        assert str(notifications[0].id) not in _ids(rows)
        assert _capped_warnings(caplog)

    def test_at_cap_returns_every_row_without_logging(self, session_client, workspace, create_user, caplog):
        _notifications(workspace, create_user, MAX_LIMIT)

        with caplog.at_level(logging.WARNING, logger="plane.api"):
            response = session_client.get(self._url(workspace))

        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == MAX_LIMIT
        assert not _capped_warnings(caplog)

    def test_pagination_params_keep_paginated_shape(self, session_client, workspace, create_user):
        _notifications(workspace, create_user, 3)

        response = session_client.get(self._url(workspace), {"per_page": 2, "cursor": "2:0:0"})

        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body["results"]) == 2
        assert body["next_page_results"] is True


@pytest.mark.contract
@pytest.mark.django_db
class TestGlobalSearchLimit:
    def _search(self, client, workspace, entity):
        response = client.get(f"/api/workspaces/{workspace.slug}/search/", {"entities": entity})
        assert response.status_code == status.HTTP_200_OK
        return response.json()["results"][entity]

    @pytest.mark.parametrize("entity,build", SEARCH_ENTITIES)
    def test_over_limit_keeps_newest_rows(self, session_client, workspace, search_project, create_user, entity, build):
        rows = build(workspace, search_project, create_user, GLOBAL_SEARCH_LIMIT + 1)
        _make_oldest(rows[0])

        results = self._search(session_client, workspace, entity)

        assert len(results) == GLOBAL_SEARCH_LIMIT
        assert str(rows[0].id) not in _ids(results)

    @pytest.mark.parametrize("entity,build", SEARCH_ENTITIES)
    def test_below_limit_returns_every_row(self, session_client, workspace, search_project, create_user, entity, build):
        rows = build(workspace, search_project, create_user, 3)

        results = self._search(session_client, workspace, entity)

        assert _ids(results) == {str(row.id) for row in rows}
