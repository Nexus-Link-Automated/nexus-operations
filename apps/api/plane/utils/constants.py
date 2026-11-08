# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Outbound HTTP timeouts, as (connect, read) seconds. `requests` has no default
# timeout, so without one a stalled peer holds the worker for as long as it stalls.
#
# Each OAuth call made during a login; self-hosted GitLab and Gitea can be slow to answer.
OAUTH_HTTP_TIMEOUT = (5, 15)
# The image search a user is waiting on in the cover image picker.
UNSPLASH_HTTP_TIMEOUT = (3, 10)
# The live server's document conversion, run from a background task and slow on large documents.
LIVE_SERVER_HTTP_TIMEOUT = (5, 60)

RESTRICTED_WORKSPACE_SLUGS = [
    "404",
    "accounts",
    "api",
    "create-workspace",
    "god-mode",
    "installations",
    "invitations",
    "onboarding",
    "profile",
    "spaces",
    "workspace-invitations",
    "password",
    "flags",
    "monitor",
    "monitoring",
    "ingest",
    "plane-pro",
    "plane-ultimate",
    "enterprise",
    "plane-enterprise",
    "disco",
    "silo",
    "chat",
    "calendar",
    "drive",
    "channels",
    "upgrade",
    "billing",
    "sign-in",
    "sign-up",
    "signin",
    "signup",
    "config",
    "live",
    "admin",
    "m",
    "import",
    "importers",
    "integrations",
    "integration",
    "configuration",
    "initiatives",
    "initiative",
    "config",
    "workflow",
    "workflows",
    "epics",
    "epic",
    "story",
    "mobile",
    "dashboard",
    "desktop",
    "onload",
    "real-time",
    "one",
    "pages",
    "mobile",
    "business",
    "pro",
    "settings",
    "monitor",
    "license",
    "licenses",
    "instances",
    "instance",
    # Root paths the hybrid deployment's gateway routes away from the web app
    # (deployments/hybrid/vps/Caddyfile). A workspace with one of these slugs
    # would be unreachable at /<slug>/.
    "agents",
    "mcp",
    "uploads",
    "static",
    "auth",
]
