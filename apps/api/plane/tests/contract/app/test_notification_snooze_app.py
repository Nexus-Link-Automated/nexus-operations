# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A notification is snoozed only until its ``snoozed_till`` passes.

After that it must be back in the inbox list and the unread counts, and no
longer in the snoozed list.
"""

from datetime import timedelta
from uuid import uuid4

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models import Notification


@pytest.fixture
def notifications(db, create_user, workspace):
    yesterday = timezone.now() - timedelta(days=1)
    tomorrow = timezone.now() + timedelta(days=1)
    built = {
        "plain": {},
        "snoozed_future": {"snoozed_till": tomorrow},
        "snoozed_past": {"snoozed_till": yesterday},
        "archived": {"archived_at": yesterday},
        "archived_snoozed": {"archived_at": yesterday, "snoozed_till": tomorrow},
        "mention_snoozed_past": {"snoozed_till": yesterday, "sender": "in_app:issue_activities:mentioned"},
        "mention_snoozed_future": {"snoozed_till": tomorrow, "sender": "in_app:issue_activities:mentioned"},
    }
    rows = {
        name: Notification(
            **{
                "workspace": workspace,
                "receiver": create_user,
                "entity_name": "issue",
                "entity_identifier": uuid4(),
                "title": name,
                "sender": "in_app:issue_activities:created",
                **fields,
            }
        )
        for name, fields in built.items()
    }
    Notification.objects.bulk_create(rows.values())
    return rows


def listed(client, slug, **params):
    response = client.get(f"/api/workspaces/{slug}/users/notifications/", params)
    assert response.status_code == status.HTTP_200_OK
    return {row["title"] for row in response.data}


@pytest.mark.contract
class TestNotificationSnooze:
    @pytest.mark.parametrize(
        "params, expected",
        [
            ({}, {"plain", "snoozed_past"}),
            ({"snoozed": "false"}, {"plain", "snoozed_past"}),
            ({"snoozed": "true"}, {"snoozed_future"}),
            ({"archived": "true"}, {"archived", "archived_snoozed"}),
            ({"mentioned": "true"}, {"mention_snoozed_past"}),
            ({"mentioned": "true", "snoozed": "true"}, {"mention_snoozed_future"}),
        ],
    )
    def test_list_treats_only_future_snoozes_as_snoozed(
        self, session_client, workspace, notifications, params, expected
    ):
        assert listed(session_client, workspace.slug, **params) == expected

    def test_unread_count_includes_expired_snoozes(self, session_client, workspace, notifications):
        response = session_client.get(f"/api/workspaces/{workspace.slug}/users/notifications/unread/")

        assert response.status_code == status.HTTP_200_OK
        assert response.data == {
            "total_unread_notifications_count": 2,
            "mention_unread_notifications_count": 1,
        }
