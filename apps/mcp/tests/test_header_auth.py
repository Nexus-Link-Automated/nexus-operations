"""The header-auth token check and the Plane URL it calls.

Both were deployment hazards: a missing URL setting silently sent every user's
token to Plane Cloud, and checking the token on every request spent the
token's whole API rate limit on authentication, then reported "invalid token".
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys

import httpx
import pytest
from fastmcp import FastMCP
from starlette.testclient import TestClient

from plane_mcp.auth import plane_header_auth_provider as header_auth
from plane_mcp.auth.plane_header_auth_provider import HeaderAuthError, PlaneHeaderAuthProvider
from plane_mcp.client import MissingBaseURLError, plane_base_url


@pytest.fixture
def no_plane_url(monkeypatch):
    monkeypatch.delenv("PLANE_BASE_URL", raising=False)
    monkeypatch.delenv("PLANE_INTERNAL_BASE_URL", raising=False)


def test_no_url_is_an_error_not_plane_cloud(no_plane_url):
    with pytest.raises(MissingBaseURLError):
        plane_base_url()


def test_internal_url_wins_and_is_normalised(monkeypatch):
    monkeypatch.setenv("PLANE_BASE_URL", "https://public.example")
    monkeypatch.setenv("PLANE_INTERNAL_BASE_URL", "http://gateway/")
    assert plane_base_url() == "http://gateway"
    monkeypatch.setenv("PLANE_INTERNAL_BASE_URL", "")
    assert plane_base_url() == "https://public.example"


def test_missing_url_is_not_swallowed_as_no_request(no_plane_url):
    """verify_token treats RuntimeError as "no HTTP request" and returns None,
    which would hide the misconfiguration behind a 401."""
    assert not issubclass(MissingBaseURLError, RuntimeError)


def test_entrypoint_refuses_to_start_without_a_url(tmp_path):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)}
    proc = subprocess.run(
        [sys.executable, "-c", "import nexus_serve"],
        cwd=str(__import__("pathlib").Path(__file__).resolve().parents[1]),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode != 0
    assert "PLANE_INTERNAL_BASE_URL" in proc.stderr


USER_ID = "4f1c2b9e-0d3a-4e5f-8a7b-6c5d4e3f2a1b"


class _FakePlane:
    """Stands in for httpx.AsyncClient and answers /users/me/ with a fixed status."""

    def __init__(self, status: int):
        self.status = status
        self.body: object = {"id": USER_ID, "email": "person@example.com"}
        self.calls: list[str] = []

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers):
        self.calls.append(url)
        return httpx.Response(self.status, json=self.body)


@pytest.fixture
def plane(monkeypatch):
    monkeypatch.setenv("PLANE_INTERNAL_BASE_URL", "http://gateway")

    def make(status: int) -> _FakePlane:
        fake = _FakePlane(status)
        monkeypatch.setattr(header_auth.httpx, "AsyncClient", fake)
        return fake

    return make


def _validate(provider, token="tok"):
    return asyncio.run(provider._validate_api_key(token))


def test_a_valid_token_is_checked_once_per_ttl(plane, monkeypatch):
    fake = plane(200)
    provider = PlaneHeaderAuthProvider()
    assert all(_validate(provider) for _ in range(5))
    assert fake.calls == ["http://gateway/api/v1/users/me/"]

    now = header_auth.time.monotonic()
    monkeypatch.setattr(header_auth.time, "monotonic", lambda: now + header_auth.VALIDATION_TTL_SECONDS + 1)
    assert _validate(provider)
    assert len(fake.calls) == 2


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_token_is_refused_briefly_without_asking_again(plane, monkeypatch, status):
    fake = plane(status)
    provider = PlaneHeaderAuthProvider()
    assert all(_validate(provider) is None for _ in range(5))
    assert len(fake.calls) == 1

    fake.status = 200
    now = header_auth.time.monotonic()
    monkeypatch.setattr(header_auth.time, "monotonic", lambda: now + header_auth.REJECTION_TTL_SECONDS + 1)
    assert _validate(provider)
    assert len(fake.calls) == 2


@pytest.mark.parametrize("status", [400, 404])
def test_other_client_errors_are_not_cached(plane, status):
    fake = plane(status)
    provider = PlaneHeaderAuthProvider()
    assert _validate(provider) is None
    assert _validate(provider) is None
    assert len(fake.calls) == 2


def test_rejections_are_cached_per_token_and_bounded(plane, monkeypatch):
    monkeypatch.setattr(header_auth, "_CACHE_SIZE", 2)
    fake = plane(401)
    provider = PlaneHeaderAuthProvider()
    for token in ("tok-a", "tok-b", "tok-c"):
        assert _validate(provider, token) is None
    assert len(provider._rejected_until) == 2
    assert all("tok" not in key for key in provider._rejected_until)
    fake.status = 200
    assert _validate(provider, "tok-a")
    assert _validate(provider, "tok-c") is None


def test_checks_share_one_http_client(plane, monkeypatch):
    fake = plane(401)
    built = []

    def build(*args, **kwargs):
        built.append(kwargs)
        return fake

    monkeypatch.setattr(header_auth.httpx, "AsyncClient", build)
    provider = PlaneHeaderAuthProvider(timeout_seconds=7)
    for token in ("tok-a", "tok-b", "tok-c"):
        _validate(provider, token)
    assert len(fake.calls) == 3
    assert built == [{"timeout": 7}]


def test_rate_limited_means_valid_not_invalid(plane):
    """Plane throttles only after authenticating, so a 429 proves the token."""
    plane(429)
    assert _validate(PlaneHeaderAuthProvider()) == ""


def test_cache_is_per_token_and_holds_no_token(plane):
    fake = plane(200)
    provider = PlaneHeaderAuthProvider()
    _validate(provider, "tok-a")
    fake.status = 401
    assert _validate(provider, "tok-b") is None
    assert all("tok" not in key for key in provider._valid_until)


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_an_upstream_failure_is_not_an_invalid_token(plane, status):
    plane(status)
    with pytest.raises(HeaderAuthError) as caught:
        _validate(PlaneHeaderAuthProvider())
    assert caught.value.status_code == 503


def test_an_unreachable_plane_is_not_an_invalid_token(plane):
    fake = plane(200)

    async def refuse(url, headers):
        raise httpx.ConnectError("connection refused")

    fake.get = refuse
    with pytest.raises(HeaderAuthError) as caught:
        _validate(PlaneHeaderAuthProvider())
    assert caught.value.status_code == 503


def test_outage_is_not_cached_as_valid(plane):
    fake = plane(503)
    provider = PlaneHeaderAuthProvider()
    with pytest.raises(HeaderAuthError):
        _validate(provider)
    fake.status = 200
    assert _validate(provider)


def test_outage_is_not_cached_as_rejected(plane):
    fake = plane(500)
    provider = PlaneHeaderAuthProvider()
    with pytest.raises(HeaderAuthError):
        _validate(provider)

    async def refuse(url, headers):
        raise httpx.ConnectError("connection refused")

    fake.get = refuse
    with pytest.raises(HeaderAuthError):
        _validate(provider)
    del fake.get
    fake.status = 200
    assert _validate(provider)
    assert not provider._rejected_until


@pytest.fixture
def http(plane):
    """The real HTTP stack, so the status a client receives is what is tested."""

    def post(status: int, headers: dict[str, str]):
        plane(status)
        mcp = FastMCP("t", auth=PlaneHeaderAuthProvider(required_scopes=["read", "write"]))
        client = TestClient(mcp.http_app(path="/mcp", stateless_http=True), raise_server_exceptions=False)
        return client.post(
            "/mcp",
            headers={"Authorization": "Bearer tok", **headers},
            json={"jsonrpc": "2.0", "method": "initialize", "id": 1},
        )

    return post


@pytest.mark.parametrize(
    ("upstream", "headers", "expected"),
    [
        (500, {"X-Workspace-Slug": "acme"}, 503),
        (401, {"X-Workspace-Slug": "acme"}, 401),
        (200, {}, 400),
        (200, {"X-Workspace-Slug": "../other"}, 400),
    ],
)
def test_the_status_the_client_receives(http, upstream, headers, expected):
    response = http(upstream, headers)
    assert response.status_code == expected, response.text
    if expected != 401:
        assert response.json()["error"]


def test_a_valid_request_gets_past_authentication(http):
    with_headers = {"X-Workspace-Slug": "acme", "Accept": "application/json, text/event-stream"}
    assert http(200, with_headers).status_code not in (400, 401, 503)


@pytest.fixture
def workspace_header(monkeypatch):
    from fastmcp.server import dependencies

    monkeypatch.setattr(dependencies, "get_http_headers", lambda *a, **k: {"x-workspace-slug": "acme"})


def _verify(provider, token="tok"):
    return asyncio.run(provider.verify_token(token))


def test_the_token_names_its_user(plane, workspace_header):
    """Logs named the workspace but not who acted in it."""
    plane(200)
    claims = _verify(PlaneHeaderAuthProvider()).claims
    assert claims["sub"] == USER_ID
    assert claims["workspace_slug"] == "acme"
    assert "person@example.com" not in repr(claims)


def test_the_user_is_cached_with_the_token(plane, workspace_header):
    fake = plane(200)
    provider = PlaneHeaderAuthProvider()
    _verify(provider)
    fake.body = {"id": "someone-else"}
    assert _verify(provider).claims["sub"] == USER_ID
    assert len(fake.calls) == 1


@pytest.mark.parametrize(
    ("status", "body"), [(429, {}), (200, {}), (200, [])], ids=["rate-limited", "no-id", "not-an-object"]
)
def test_a_valid_token_without_a_known_user_has_no_sub(plane, workspace_header, status, body):
    fake = plane(status)
    fake.body = body
    token = _verify(PlaneHeaderAuthProvider())
    assert token is not None
    assert "sub" not in token.claims


_LOG_SCRIPT = f"""
import asyncio, logging

import httpx
from fastmcp.server import dependencies

import plane_mcp.__main__ as main
from plane_mcp.auth import plane_header_auth_provider as header_auth

class Plane:
    def __init__(self, *args, **kwargs):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *exc):
        return False
    async def get(self, url, headers):
        return httpx.Response(200, json={{"id": "{USER_ID}", "email": "person@example.com"}})

header_auth.httpx.AsyncClient = Plane
dependencies.get_http_headers = lambda *a, **k: {{"x-workspace-slug": "acme"}}
token = asyncio.run(header_auth.PlaneHeaderAuthProvider().verify_token("tok"))
main.get_access_token = lambda: token
logging.getLogger("fastmcp.plane_mcp.tools").info("tool called")
"""


def test_a_header_auth_log_line_names_the_user_and_workspace(tmp_path):
    """The real log filter and formatter, fed the token header auth produced."""
    proc = subprocess.run(
        [sys.executable, "-c", _LOG_SCRIPT],
        cwd=str(__import__("pathlib").Path(__file__).resolve().parents[1]),
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "PLANE_INTERNAL_BASE_URL": "http://gateway"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    line = json.loads(proc.stderr.strip().splitlines()[-1])
    assert line["message"] == "tool called"
    assert line["workspace_slug"] == "acme"
    assert line["user_id"] == USER_ID
    assert "person@example.com" not in proc.stderr
