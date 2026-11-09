# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for which external API requests reach the API activity log."""

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone
from rest_framework import status

from plane.db.models.api import APIToken

USERS_ME_URL = "/api/v1/users/me/"
REJECTED = (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)


@pytest.fixture
def process_logs():
    with patch("plane.middleware.logger.process_logs") as mocked:
        yield mocked


@pytest.mark.contract
class TestAPITokenLogging:
    @pytest.mark.django_db
    def test_valid_key_is_recorded_and_an_unknown_key_is_not(self, api_client, api_token, process_logs):
        api_client.credentials(HTTP_X_API_KEY=api_token.token)
        assert api_client.get(USERS_ME_URL).status_code == status.HTTP_200_OK
        process_logs.delay.assert_called_once()

        process_logs.delay.reset_mock()
        api_client.credentials(HTTP_X_API_KEY="not-a-real-key")
        assert api_client.get(USERS_ME_URL).status_code in REJECTED
        process_logs.delay.assert_not_called()

    @pytest.mark.django_db
    def test_expired_key_is_not_recorded(self, api_client, api_token, process_logs):
        APIToken.objects.filter(pk=api_token.pk).update(expired_at=timezone.now() - timedelta(minutes=1))
        api_client.credentials(HTTP_X_API_KEY=api_token.token)

        assert api_client.get(USERS_ME_URL).status_code in REJECTED
        process_logs.delay.assert_not_called()

    @pytest.mark.django_db
    def test_route_without_authentication_is_not_recorded(self, api_key_client, process_logs):
        assert api_key_client.get("/no-such-route/").status_code == status.HTTP_404_NOT_FOUND
        process_logs.delay.assert_not_called()
