# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The deployment templates give each client one rate-limit identity it cannot change."""

import re
from pathlib import Path

import pytest
from django.conf import settings
from django.test import RequestFactory, override_settings

from plane.authentication.rate_limit import AuthenticationThrottle

CADDYFILES = ["apps/proxy/Caddyfile.ce", "apps/proxy/Caddyfile.aio.ce"]
TRUSTED_PROXIES_TEMPLATES = [
    "deployments/cli/community/variables.env",
    "deployments/aio/community/variables.env",
    ".env.example",
]
NUM_PROXIES_TEMPLATES = [
    "deployments/cli/community/variables.env",
    "deployments/aio/community/variables.env",
    "apps/api/.env.example",
]


@pytest.fixture(scope="module")
def repo_root():
    # docker-compose-test.yml mounts the repository at /repo; a plain checkout walks up to it.
    for candidate in (Path("/repo"), *Path(__file__).resolve().parents):
        if (candidate / "apps/proxy/Caddyfile.ce").is_file():
            return candidate
    pytest.fail("Repository root not found; these tests read the deployment templates")


def env_value(path, key):
    for line in path.read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    return None


def client_identity(num_proxies, forwarded_for):
    request = RequestFactory().get("/", HTTP_X_FORWARDED_FOR=forwarded_for, REMOTE_ADDR="172.18.0.5")
    with override_settings(REST_FRAMEWORK={**settings.REST_FRAMEWORK, "NUM_PROXIES": num_proxies}):
        return AuthenticationThrottle().get_cache_key(request, None)


@pytest.mark.unit
class TestShippedProxyDefaults:
    @pytest.mark.parametrize("caddyfile", CADDYFILES)
    def test_bundled_proxy_defaults_to_private_ranges(self, repo_root, caddyfile):
        match = re.search(r"trusted_proxies static \{\$TRUSTED_PROXIES:([^}]*)\}", (repo_root / caddyfile).read_text())

        assert match is not None
        assert match.group(1) == "private_ranges"

    @pytest.mark.parametrize("template", TRUSTED_PROXIES_TEMPLATES)
    def test_templates_ship_private_ranges(self, repo_root, template):
        assert env_value(repo_root / template, "TRUSTED_PROXIES") == "private_ranges"

    @pytest.mark.parametrize("template", NUM_PROXIES_TEMPLATES)
    def test_shipped_num_proxies_uses_the_address_seen_by_the_bundled_proxy(self, repo_root, template):
        value = env_value(repo_root / template, "NUM_PROXIES")
        num_proxies = int(value) if value else None

        # The bundled proxy appends the address it saw after whatever the client sent.
        first = client_identity(num_proxies, "198.51.100.1, 203.0.113.9")
        second = client_identity(num_proxies, "198.51.100.2, 203.0.113.9")

        assert first == second
        assert first.endswith("203.0.113.9")

    def test_compose_falls_back_to_the_bundled_proxy_values(self, repo_root):
        compose = (repo_root / "deployments/cli/community/docker-compose.yml").read_text()

        assert "TRUSTED_PROXIES: ${TRUSTED_PROXIES:-private_ranges}" in compose
        assert "NUM_PROXIES: ${NUM_PROXIES:-1}" in compose

    def test_all_in_one_image_accepts_values_for_an_extra_load_balancer(self, repo_root):
        start_script = (repo_root / "deployments/aio/community/start.sh").read_text()

        assert 'update_env_value "TRUSTED_PROXIES" "${TRUSTED_PROXIES:-private_ranges}"' in start_script
        assert 'update_env_value "NUM_PROXIES" "${NUM_PROXIES:-1}"' in start_script
