# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for GET /api/workspaces/<slug>/agents/ (member-facing agent list)."""

import pytest
from rest_framework import status

from plane.db.models import AgentProviderCredential, User, Workspace, WorkspaceMember
from plane.license.models import AgentDefinition

MEMBER_FIELDS = {
    "id",
    "name",
    "slug",
    "description",
    "adapter",
    "default_permission_level",
    "max_permission_level",
    "credential_source",
}


def _url(slug):
    return f"/api/workspaces/{slug}/agents/"


def _make_agent(slug, env=None, **overrides):
    overrides.setdefault("adapter", "claude")
    agent = AgentDefinition(name=slug.title(), slug=slug, **overrides)
    agent.set_env({"ANTHROPIC_API_KEY": f"sk-{slug}-secret"} if env is None else env)
    agent.save()
    return agent


def _sources(response):
    return {item["slug"]: item["credential_source"] for item in response.json()}


@pytest.mark.contract
class TestWorkspaceAgents:
    @pytest.mark.django_db
    def test_member_sees_enabled_agents_only_without_env(self, session_client, workspace):
        enabled = _make_agent("claude", sort_order=2)
        second = _make_agent("codex", sort_order=1)
        _make_agent("hidden", is_enabled=False)

        response = session_client.get(_url(workspace.slug))

        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert [item["slug"] for item in body] == ["codex", "claude"]  # sort_order
        assert {item["id"] for item in body} == {str(enabled.id), str(second.id)}
        for item in body:
            assert set(item) == MEMBER_FIELDS
        assert b"sk-" not in response.content
        assert b"env" not in response.content

    @pytest.mark.django_db
    def test_credential_source_follows_the_chat_precedence(self, session_client, workspace, create_user):
        _make_agent("claude-admin")
        _make_agent("claude-bare", env={})
        _make_agent("codex-bare", adapter="codex", env={})
        _make_agent("gemini-bare", adapter="gemini", env={})
        _make_agent("deepseek", adapter="deepseek", env={"DEEPSEEK_API_KEY": "sk-deepseek-secret"})
        _make_agent("deepseek-bare", adapter="deepseek", env={})
        # Anthropic: a workspace key; OpenAI: both, so the member's own wins; Google: another member's only.
        other = User.objects.create(email="other-agents@plane.so", username="other-agents")
        WorkspaceMember.objects.create(workspace=workspace, member=other, role=15)
        for user, provider, method in [
            (None, "anthropic", "api_key"),
            (None, "openai", "api_key"),
            (create_user, "openai", "chatgpt"),
            (other, "google", "api_key"),
        ]:
            AgentProviderCredential.objects.create(workspace=workspace, user=user, provider=provider, method=method)

        response = session_client.get(_url(workspace.slug))

        assert response.status_code == status.HTTP_200_OK
        assert _sources(response) == {
            "claude-admin": "workspace",
            "claude-bare": "workspace",
            "codex-bare": "personal",
            "gemini-bare": None,
            "deepseek": "instance",
            "deepseek-bare": None,
        }

    @pytest.mark.django_db
    def test_credential_source_falls_back_to_the_agents_admin_env(self, session_client, workspace):
        _make_agent("claude-admin")
        _make_agent("claude-oauth", env={"CLAUDE_CODE_OAUTH_TOKEN": "oauth-secret"})
        _make_agent("claude-bare", env={})

        response = session_client.get(_url(workspace.slug))

        assert _sources(response) == {"claude-admin": "instance", "claude-oauth": "instance", "claude-bare": None}
        assert b"secret" not in response.content

    @pytest.mark.django_db
    def test_guest_member_can_list(self, api_client, workspace):
        guest = User.objects.create(email="guest@plane.so", username="guest-agents")
        WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)
        _make_agent("claude")
        api_client.force_authenticate(user=guest)

        response = api_client.get(_url(workspace.slug))

        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == 1

    @pytest.mark.django_db
    def test_non_member_is_rejected(self, session_client, create_user):
        other_owner = User.objects.create(email="other-owner@plane.so", username="other-owner")
        other = Workspace.objects.create(name="Other", slug="other-agents", owner=other_owner)
        WorkspaceMember.objects.create(workspace=other, member=other_owner, role=20)
        _make_agent("claude")

        response = session_client.get(_url(other.slug))

        assert response.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_inactive_member_is_rejected(self, session_client, workspace, create_user):
        WorkspaceMember.objects.filter(workspace=workspace, member=create_user).update(is_active=False)
        _make_agent("claude")

        response = session_client.get(_url(workspace.slug))

        assert response.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.django_db
    def test_anonymous_is_rejected(self, api_client, workspace):
        response = api_client.get(_url(workspace.slug))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
