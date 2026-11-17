# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A small stand-in for GitHub's REST API, enough for `plane.coding.github` and `plane.coding.publish`.

It checks the App's JWT against the App's public key, hands out installation tokens and remembers what each one may
do, and records every request so tests can say exactly what the CRM asked GitHub for.
"""

import hashlib
import itertools
import json
import re
from dataclasses import dataclass, field

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

APP_ID = "123456"


def make_key() -> tuple[str, object]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    return pem, key.public_key()


@dataclass
class FakeRepo:
    owner: str
    name: str
    private: bool = False
    default_branch: str = "main"
    installation: int | None = 42
    refs: dict = field(default_factory=dict)
    commits: dict = field(default_factory=dict)


class FakeGitHub:
    def __init__(self, public_key):
        self.public_key = public_key
        self.repos: dict[str, FakeRepo] = {}
        self.requests: list[tuple[str, str, dict | None, str]] = []
        self.tokens: dict[str, dict] = {}
        self.pulls: list[dict] = []
        self.counter = itertools.count(1)
        # path regex -> (status, body): forced answers for failure tests.
        self.fail: dict[str, tuple[int, dict]] = {}
        self.grant_extra = False
        self.no_draft = False

    def add_repo(self, owner="example", name="app", **kwargs) -> FakeRepo:
        repo = FakeRepo(owner=owner, name=name, **kwargs)
        base = "a" * 40
        repo.commits[base] = {"tree": "t" * 40}
        repo.refs[f"refs/heads/{repo.default_branch}"] = base
        self.repos[f"{owner}/{name}".lower()] = repo
        return repo

    @property
    def transport(self):
        return httpx.MockTransport(self.handle)

    # -- helpers

    def calls(self, method=None, pattern=""):
        return [r for r in self.requests if (method is None or r[0] == method) and re.search(pattern, r[1])]

    def _sha(self, *parts) -> str:
        return hashlib.sha1(("|".join(map(str, parts)) + str(next(self.counter))).encode()).hexdigest()

    def _auth(self, request):
        header = request.headers.get("authorization", "")
        return header[7:] if header.startswith("Bearer ") else None

    def _app(self, request) -> bool:
        token = self._auth(request)
        try:
            claims = jwt.decode(token, self.public_key, algorithms=["RS256"])
        except Exception:
            return False
        return claims.get("iss") == APP_ID and claims["exp"] - claims["iat"] <= 600

    def _token_for(self, request, repo: FakeRepo, permission: str, level: str) -> bool:
        grant = self.tokens.get(self._auth(request) or "")
        if not grant or grant["repo"] != f"{repo.owner}/{repo.name}".lower():
            return False
        have = grant["permissions"].get(permission)
        return have == level or (level == "read" and have == "write")

    # -- the API

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, path, body, self._auth(request) or ""))
        for pattern, (status, answer) in self.fail.items():
            if re.search(pattern, f"{request.method} {path}"):
                return httpx.Response(status, json=answer)

        if m := re.fullmatch(r"/repos/([^/]+)/([^/]+)/installation", path):
            if not self._app(request):
                return httpx.Response(401, json={"message": "Bad credentials"})
            repo = self.repos.get(f"{m[1]}/{m[2]}".lower())
            if repo is None or repo.installation is None:
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(200, json={"id": repo.installation})

        if m := re.fullmatch(r"/app/installations/(\d+)/access_tokens", path):
            if not self._app(request):
                return httpx.Response(401, json={"message": "Bad credentials"})
            names = body.get("repositories") or []
            repos = [r for r in self.repos.values() if r.installation == int(m[1]) and r.name in names]
            if len(repos) != 1:
                return httpx.Response(422, json={"message": "There is at least one repository that does not exist"})
            token = f"ghs_{self._sha('token')[:36]}"
            permissions = dict(body.get("permissions") or {})
            granted = {**permissions, "metadata": "read"}
            if self.grant_extra:
                granted["administration"] = "write"
            self.tokens[token] = {"repo": f"{repos[0].owner}/{repos[0].name}".lower(), "permissions": permissions}
            return httpx.Response(
                201,
                json={
                    "token": token,
                    "expires_at": "2099-01-01T01:00:00Z",
                    "permissions": granted,
                    "repositories": [{"name": repos[0].name, "full_name": f"{repos[0].owner}/{repos[0].name}"}],
                },
            )

        m = re.fullmatch(r"/repos/([^/]+)/([^/]+)(/.*)?", path)
        if not m:
            return httpx.Response(404, json={"message": "Not Found"})
        repo = self.repos.get(f"{m[1]}/{m[2]}".lower())
        rest = m[3] or ""
        if repo is None:
            return httpx.Response(404, json={"message": "Not Found"})

        if rest == "" and request.method == "GET":
            if not self._token_for(request, repo, "contents", "read"):
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(200, json={"private": repo.private, "default_branch": repo.default_branch})

        write = request.method != "GET"
        if not self._token_for(
            request, repo, "pull_requests" if rest == "/pulls" else "contents", "write" if write else "read"
        ):
            return httpx.Response(403, json={"message": "Resource not accessible by integration"})

        if c := re.fullmatch(r"/git/commits/([0-9a-f]{40})", rest):
            commit = repo.commits.get(c[1])
            if commit is None:
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(200, json={"sha": c[1], "tree": {"sha": commit["tree"]}})
        if rest == "/git/blobs":
            return httpx.Response(201, json={"sha": self._sha("blob", body["content"])})
        if rest == "/git/trees":
            same = not body["tree"]
            return httpx.Response(201, json={"sha": body["base_tree"] if same else self._sha("tree", body)})
        if rest == "/git/commits":
            sha = self._sha("commit", body)
            repo.commits[sha] = {"tree": body["tree"], "parents": body["parents"]}
            return httpx.Response(201, json={"sha": sha})
        if rest == "/git/refs":
            if body["ref"] in repo.refs:
                return httpx.Response(422, json={"message": "Reference already exists"})
            repo.refs[body["ref"]] = body["sha"]
            return httpx.Response(201, json={"ref": body["ref"], "object": {"sha": body["sha"]}})
        if rest == "/pulls":
            if body.get("draft") and self.no_draft:
                return httpx.Response(
                    422, json={"message": "Draft pull requests are not supported in this repository."}
                )
            number = len(self.pulls) + 1
            self.pulls.append(body)
            return httpx.Response(
                201, json={"number": number, "html_url": f"https://github.com/{repo.owner}/{repo.name}/pull/{number}"}
            )
        return httpx.Response(404, json={"message": "Not Found"})
