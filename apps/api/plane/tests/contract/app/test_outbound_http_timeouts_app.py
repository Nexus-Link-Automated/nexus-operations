# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

import pytest
import requests
from django.test import Client
from django.urls import reverse

from plane.authentication.adapter.error import AUTHENTICATION_ERROR_CODES
from plane.utils.constants import OAUTH_HTTP_TIMEOUT, UNSPLASH_HTTP_TIMEOUT

STATE = "expected-state"
CALLBACK_PARAMS = {"code": "oauth-code", "state": STATE}
TOKEN_PAYLOAD = {"access_token": "provider-token"}
USER_PAYLOAD = {"login": "octocat", "id": 1}

GITHUB_CONFIG = ("client-id", "client-secret", "")
GITHUB_ORG_CONFIG = ("client-id", "client-secret", "acme")
GITLAB_CONFIG = ("client-id", "client-secret", "https://gitlab.example.com")
GOOGLE_CONFIG = ("client-id", "client-secret")
GITEA_CONFIG = ("client-id", "client-secret", "https://gitea.example.com")

CALLBACKS = [
    ("github-callback", "github", GITHUB_CONFIG, "GITHUB_OAUTH_PROVIDER_ERROR"),
    ("gitlab-callback", "gitlab", GITLAB_CONFIG, "GITLAB_OAUTH_PROVIDER_ERROR"),
    ("google-callback", "google", GOOGLE_CONFIG, "GOOGLE_OAUTH_PROVIDER_ERROR"),
    ("gitea-callback", "gitea", GITEA_CONFIG, "GITEA_OAUTH_PROVIDER_ERROR"),
    ("space-github-callback", "github", GITHUB_CONFIG, "GITHUB_OAUTH_PROVIDER_ERROR"),
    ("space-gitlab-callback", "gitlab", GITLAB_CONFIG, "GITLAB_OAUTH_PROVIDER_ERROR"),
    ("space-google-callback", "google", GOOGLE_CONFIG, "GOOGLE_OAUTH_PROVIDER_ERROR"),
    ("space-gitea-callback", "gitea", GITEA_CONFIG, "GITEA_OAUTH_PROVIDER_ERROR"),
]

UNSPLASH_URL = "/api/unsplash/"
UNSPLASH_KEY = "unsplash-access-key"


def _client():
    client = Client()
    session = client.session
    session["host"] = "http://localhost"
    session["state"] = STATE
    session.save()
    return client


def _configured(module, config):
    return patch(f"plane.authentication.provider.oauth.{module}.get_configuration_value", return_value=config)


def _response(payload, status_code=200):
    response = MagicMock(status_code=status_code, ok=status_code < 400)
    response.json.return_value = payload
    return response


def _token_exchange_succeeds():
    return patch("requests.post", return_value=_response(TOKEN_PAYLOAD))


def _assert_login_failed_with(client, response, error_name):
    assert response.status_code == 302
    query = parse_qs(urlparse(response.url).query)
    assert query["error_code"] == [str(AUTHENTICATION_ERROR_CODES[error_name])]
    assert "_auth_user_id" not in client.session


@pytest.mark.contract
@pytest.mark.django_db
@pytest.mark.parametrize("url_name,module,config,error_name", CALLBACKS, ids=[c[0] for c in CALLBACKS])
class TestOAuthCallbackProviderTimeout:
    """A provider that stops answering ends the login with the provider's error, on a bounded wait."""

    def test_token_exchange(self, url_name, module, config, error_name):
        client = _client()

        with _configured(module, config), patch("requests.post", side_effect=requests.Timeout) as post:
            response = client.get(reverse(url_name), CALLBACK_PARAMS)

        assert post.call_args.kwargs["timeout"] == OAUTH_HTTP_TIMEOUT
        _assert_login_failed_with(client, response, error_name)

    def test_user_info(self, url_name, module, config, error_name):
        client = _client()

        with (
            _configured(module, config),
            _token_exchange_succeeds(),
            patch("requests.get", side_effect=requests.Timeout) as get,
        ):
            response = client.get(reverse(url_name), CALLBACK_PARAMS)

        assert get.call_args.kwargs["timeout"] == OAUTH_HTTP_TIMEOUT
        _assert_login_failed_with(client, response, error_name)


@pytest.mark.contract
@pytest.mark.django_db
class TestOAuthEmailLookupTimeout:
    @pytest.mark.parametrize(
        "module,url_name,config,error_name",
        [
            ("github", "github-callback", GITHUB_CONFIG, "GITHUB_OAUTH_PROVIDER_ERROR"),
            ("gitea", "gitea-callback", GITEA_CONFIG, "GITEA_OAUTH_PROVIDER_ERROR"),
        ],
        ids=["github", "gitea"],
    )
    def test_email_lookup(self, module, url_name, config, error_name):
        client = _client()

        with (
            _configured(module, config),
            _token_exchange_succeeds(),
            patch("requests.get", side_effect=[_response(USER_PAYLOAD), requests.Timeout()]) as get,
        ):
            response = client.get(reverse(url_name), CALLBACK_PARAMS)

        assert get.call_args.args[0].endswith("/emails")
        assert get.call_args.kwargs["timeout"] == OAUTH_HTTP_TIMEOUT
        _assert_login_failed_with(client, response, error_name)


@pytest.mark.contract
@pytest.mark.django_db
class TestGitHubOrganizationCheck:
    @pytest.mark.parametrize("error", [requests.Timeout, requests.ConnectionError], ids=["timeout", "connection-error"])
    def test_provider_failure_ends_login_with_provider_error(self, error):
        client = _client()

        with (
            _configured("github", GITHUB_ORG_CONFIG),
            _token_exchange_succeeds(),
            patch("requests.get", side_effect=[_response(USER_PAYLOAD), error()]) as get,
        ):
            response = client.get(reverse("github-callback"), CALLBACK_PARAMS)

        assert get.call_args.args[0].endswith("/orgs/acme/memberships/octocat")
        assert get.call_args.kwargs["timeout"] == OAUTH_HTTP_TIMEOUT
        _assert_login_failed_with(client, response, "GITHUB_OAUTH_PROVIDER_ERROR")

    def test_non_member_is_still_refused(self):
        client = _client()

        with (
            _configured("github", GITHUB_ORG_CONFIG),
            _token_exchange_succeeds(),
            patch("requests.get", side_effect=[_response(USER_PAYLOAD), _response({}, status_code=404)]) as get,
        ):
            response = client.get(reverse("github-callback"), CALLBACK_PARAMS)

        assert get.call_args.kwargs["timeout"] == OAUTH_HTTP_TIMEOUT
        _assert_login_failed_with(client, response, "GITHUB_USER_NOT_IN_ORG")


@pytest.mark.contract
@pytest.mark.django_db
class TestUnsplashProviderFailure:
    @pytest.fixture(autouse=True)
    def _configured(self):
        with patch("plane.app.views.external.base.get_configuration_value", return_value=(UNSPLASH_KEY,)):
            yield

    def test_provider_response_is_passed_through_on_a_bounded_wait(self, session_client):
        with patch("requests.get", return_value=_response([{"id": "photo"}])) as get:
            response = session_client.get(UNSPLASH_URL)

        assert response.status_code == 200
        assert response.json() == [{"id": "photo"}]
        assert get.call_args.kwargs["timeout"] == UNSPLASH_HTTP_TIMEOUT

    @pytest.mark.parametrize("error", [requests.Timeout, requests.ConnectionError], ids=["timeout", "connection-error"])
    def test_provider_failure_returns_bad_gateway_without_the_access_key(self, session_client, caplog, error):
        # requests puts the full URL, and so the client_id, in the exception text
        with patch("requests.get", side_effect=error(f"url: /photos/?client_id={UNSPLASH_KEY}")) as get:
            response = session_client.get(UNSPLASH_URL)

        assert response.status_code == 502
        assert response.json() == {"error": "Could not fetch images from Unsplash"}
        assert get.call_args.kwargs["timeout"] == UNSPLASH_HTTP_TIMEOUT
        assert UNSPLASH_KEY not in caplog.text

    def test_non_json_provider_response_returns_bad_gateway(self, session_client):
        invalid = _response(None, status_code=503)
        invalid.json.side_effect = requests.exceptions.JSONDecodeError("Expecting value", "<html>", 0)

        with patch("requests.get", return_value=invalid):
            response = session_client.get(UNSPLASH_URL)

        assert response.status_code == 502
