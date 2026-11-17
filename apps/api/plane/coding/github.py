# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The CRM's GitHub App: short-lived tokens for one repository at a time.

The App's id and private key live only in the server's settings (`GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY` or
`GITHUB_APP_PRIVATE_KEY_PATH`). The CRM signs a JWT with the key (valid 9 minutes), finds the App's installation on
the project's repository, and asks GitHub for an installation token limited to that one repository and to the
permissions the task needs:

- Pushing the job's branch and opening its pull request (`publish.py`): contents and pull requests, write. The token
  never leaves the CRM: it is used, then dropped.
- Cloning a private repository (`dispatch.py`): contents, read. It goes in the job's order, only when the repository
  is private.

GitHub ends installation tokens after one hour; the CRM never stores one. Errors read as `GitHubError` with a reason a
person can act on; the token never appears in one.
"""

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
import jwt
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger("plane.coding")

__all__ = [
    "CLONE_PERMISSIONS",
    "PUSH_PERMISSIONS",
    "GitHubError",
    "Repo",
    "RepoToken",
    "app_configured",
    "client",
    "clone_token",
    "installation_id",
    "parse_repo",
    "repo_token",
]

DEFAULT_API_URL = "https://api.github.com"
DEFAULT_WEB_URL = "https://github.com"
API_VERSION = "2022-11-28"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
# How long a found installation (or its absence) and a repository's visibility are remembered.
LOOKUP_CACHE_SECONDS = 300

PUSH_PERMISSIONS = {"contents": "write", "pull_requests": "write"}
CLONE_PERMISSIONS = {"contents": "read"}

# Tests swap this for an `httpx.MockTransport` standing in for GitHub.
_transport: httpx.BaseTransport | None = None


class GitHubError(Exception):
    """Something GitHub refused or could not do, said for a person. `status` is GitHub's HTTP status, if any."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass(frozen=True)
class Repo:
    owner: str
    name: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def path(self) -> str:
        return f"/repos/{quote(self.owner, safe='')}/{quote(self.name, safe='')}"


@dataclass(frozen=True)
class RepoToken:
    token: str
    expires_at: str

    def __repr__(self) -> str:  # never print the token itself
        return f"RepoToken(expires_at={self.expires_at!r})"


def api_url() -> str:
    return (getattr(settings, "GITHUB_API_URL", "") or DEFAULT_API_URL).rstrip("/")


def web_url() -> str:
    return (getattr(settings, "GITHUB_WEB_URL", "") or DEFAULT_WEB_URL).rstrip("/")


def _private_key() -> str:
    key = getattr(settings, "GITHUB_APP_PRIVATE_KEY", "") or ""
    if not key:
        path = getattr(settings, "GITHUB_APP_PRIVATE_KEY_PATH", "") or ""
        if path:
            try:
                key = Path(path).read_text()
            except OSError:
                logger.warning("coding: the GitHub App private key file cannot be read")
                return ""
    # An environment variable often carries the PEM with literal "\n".
    return key.replace("\\n", "\n").strip()


def app_configured() -> bool:
    return bool(getattr(settings, "GITHUB_APP_ID", "") and _private_key())


def install_url() -> str | None:
    slug = getattr(settings, "GITHUB_APP_SLUG", "") or ""
    return f"{web_url()}/apps/{quote(slug, safe='')}/installations/new" if slug else None


_NAME_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


def parse_repo(repo_url: str) -> Repo | None:
    """The GitHub repository a project's repo URL names (`https://github.com/<owner>/<name>[.git]`), or None when it
    is not one on this CRM's GitHub."""
    try:
        parts = urlsplit(repo_url or "")
        web = urlsplit(web_url())
    except ValueError:
        return None
    if parts.scheme != "https" or parts.hostname is None or parts.hostname.lower() != (web.hostname or "").lower():
        return None
    if parts.username or parts.password or parts.query or parts.fragment or parts.port not in (None, web.port):
        return None
    segments = [segment for segment in parts.path.split("/") if segment]
    if len(segments) != 2:
        return None
    owner, name = segments
    if name.endswith(".git"):
        name = name[:-4]
    for value in (owner, name):
        if not value or value in (".", "..") or not set(value) <= _NAME_CHARS:
            return None
    return Repo(owner=owner, name=name)


def client(token: str | None = None) -> httpx.Client:
    """An HTTP client for GitHub's API; with `token`, authenticated as an installation."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "nexus-coding-jobs",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(
        base_url=api_url(), headers=headers, timeout=TIMEOUT, transport=_transport, follow_redirects=False
    )


def _app_jwt() -> str:
    now = int(time.time())
    # Backdated a minute for clock drift; GitHub takes at most 10 minutes.
    payload = {"iat": now - 60, "exp": now + 9 * 60, "iss": str(settings.GITHUB_APP_ID)}
    try:
        return jwt.encode(payload, _private_key(), algorithm="RS256")
    except Exception as error:  # a malformed key
        raise GitHubError("The CRM's GitHub App private key is not a valid RSA key.") from error


def _app_client() -> httpx.Client:
    http = client()
    http.headers["Authorization"] = f"Bearer {_app_jwt()}"
    return http


def _message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    message = body.get("message") if isinstance(body, dict) else None
    return f"{message} (HTTP {response.status_code})" if message else f"HTTP {response.status_code}"


def request(http: httpx.Client, method: str, path: str, **kwargs) -> httpx.Response:
    """A request that raises `GitHubError` when GitHub cannot be reached."""
    try:
        return http.request(method, path, **kwargs)
    except httpx.HTTPError as error:
        raise GitHubError(f"GitHub could not be reached ({error.__class__.__name__}).") from error


def installation_id(repo: Repo) -> int | None:
    """The App's installation on `repo`, or None when the App is not installed there."""
    if not app_configured():
        raise GitHubError("The CRM has no GitHub App set up.")
    key = f"coding:github:installation:{repo.full_name.lower()}"
    cached = cache.get(key)
    if cached is not None:
        return cached or None
    with _app_client() as http:
        response = request(http, "GET", f"{repo.path}/installation")
    if response.status_code == 404:
        cache.set(key, 0, LOOKUP_CACHE_SECONDS)
        return None
    if response.status_code != 200:
        raise GitHubError(f"GitHub did not say whether the App is installed on {repo.full_name}: {_message(response)}.")
    found = response.json().get("id")
    if not isinstance(found, int):
        raise GitHubError("GitHub's answer about the App's installation has no id.")
    cache.set(key, found, LOOKUP_CACHE_SECONDS)
    return found


def repo_token(repo: Repo, permissions: dict) -> RepoToken:
    """A new installation token for `repo` alone, with exactly `permissions`. Never stored by the CRM."""
    installation = installation_id(repo)
    if installation is None:
        raise GitHubError(f"The CRM's GitHub App is not installed on {repo.full_name}.")
    with _app_client() as http:
        response = request(
            http,
            "POST",
            f"/app/installations/{installation}/access_tokens",
            json={"repositories": [repo.name], "permissions": permissions},
        )
    if response.status_code != 201:
        if response.status_code in (404, 422):
            # Uninstalled meanwhile, or the installation lacks access to this repository or a permission.
            cache.delete(f"coding:github:installation:{repo.full_name.lower()}")
        raise GitHubError(
            f"GitHub refused a token for {repo.full_name} ({_message(response)}). The App may lack access to the "
            f"repository or the {', '.join(sorted(permissions))} permission.",
            status=response.status_code,
        )
    body = response.json()
    token, expires_at = body.get("token"), body.get("expires_at")
    if not isinstance(token, str) or not token or not isinstance(expires_at, str):
        raise GitHubError("GitHub's token answer has no token.")
    # GitHub echoes what it granted: one repository and nothing beyond what was asked.
    granted_repos = body.get("repositories")
    if granted_repos is not None and [r.get("name", "").lower() for r in granted_repos] != [repo.name.lower()]:
        raise GitHubError("GitHub granted a token for more than the one repository asked for.")
    granted = body.get("permissions") or {}
    for name, level in granted.items():
        if name == "metadata" and level == "read":
            continue  # every installation token can read metadata
        if permissions.get(name) != level:
            raise GitHubError("GitHub granted a token with more permissions than asked for.")
    return RepoToken(token=token, expires_at=expires_at)


def repo_info(repo: Repo, token: RepoToken) -> dict:
    """`{"private", "default_branch"}` for `repo`, read with an installation token."""
    with client(token.token) as http:
        response = request(http, "GET", repo.path)
    if response.status_code != 200:
        raise GitHubError(
            f"GitHub did not describe {repo.full_name}: {_message(response)}.", status=response.status_code
        )
    body = response.json()
    return {"private": bool(body.get("private", True)), "default_branch": str(body.get("default_branch") or "")}


def _private_without_token(repo: Repo) -> bool | None:
    """False for a public repository, True when GitHub does not show it without a token, None when GitHub did not say
    (a rate limit, an outage)."""
    with client() as http:
        response = request(http, "GET", repo.path)
    if response.status_code == 200:
        return bool(response.json().get("private", False))
    if response.status_code == 404:
        return True
    return None


def clone_token(repo_url: str) -> RepoToken | None:
    """A read-only token to clone the project's repository, only when it is a private GitHub repository the App is
    installed on. None otherwise, and when GitHub cannot be asked (the clone then reports what went wrong)."""
    repo = parse_repo(repo_url)
    if repo is None or not app_configured():
        return None
    try:
        visibility_key = f"coding:github:private:{repo.full_name.lower()}"
        private = cache.get(visibility_key)
        if private is None:
            # Asked without a token first, so a public repository never costs one.
            private = _private_without_token(repo)
            if private is not None:
                cache.set(visibility_key, private, LOOKUP_CACHE_SECONDS)
        if private is False:
            return None
        token = repo_token(repo, CLONE_PERMISSIONS)
        if private is None:
            private = repo_info(repo, token)["private"]
            cache.set(visibility_key, private, LOOKUP_CACHE_SECONDS)
        return token if private else None
    except GitHubError as error:
        logger.warning("coding: no clone token for %s: %s", repo.full_name, error.message)
        return None
