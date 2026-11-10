# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The session middleware picks the admin cookie only for instance-admin endpoints."""

import pytest
from django.conf import settings
from django.http import HttpResponse
from django.test import RequestFactory

from plane.authentication.middleware.session import SessionMiddleware

USER_KEY = "userkey0123456789"
ADMIN_KEY = "adminkey0123456789"


def run_request(path):
    middleware = SessionMiddleware(lambda request: HttpResponse())
    request = RequestFactory().get(path)
    request.COOKIES[settings.SESSION_COOKIE_NAME] = USER_KEY
    request.COOKIES[settings.ADMIN_SESSION_COOKIE_NAME] = ADMIN_KEY
    middleware.process_request(request)
    return request


@pytest.mark.unit
class TestSessionCookieSelection:
    @pytest.mark.parametrize(
        "path",
        [
            "/api/instances/",
            "/api/instances/admins/me/",
            "/api/instances/admins/sign-in/",
        ],
    )
    def test_instance_admin_endpoints_use_the_admin_cookie(self, path):
        assert run_request(path).session.session_key == ADMIN_KEY

    @pytest.mark.parametrize(
        "path",
        [
            "/api/users/me/",
            "/api/workspaces/instances/projects/",
            "/api/workspaces/my-instances/members/me/",
            "/api/workspaces/team/projects/instances-board/",
        ],
    )
    def test_other_endpoints_use_the_user_cookie(self, path):
        assert run_request(path).session.session_key == USER_KEY

    @pytest.mark.django_db
    def test_emptied_session_deletes_only_the_user_cookie_on_a_workspace_path(self):
        middleware = SessionMiddleware(lambda request: HttpResponse())
        request = run_request("/api/workspaces/instances/projects/")
        request.session.flush()

        response = middleware.process_response(request, HttpResponse())

        assert response.cookies[settings.SESSION_COOKIE_NAME].value == ""
        assert settings.ADMIN_SESSION_COOKIE_NAME not in response.cookies
