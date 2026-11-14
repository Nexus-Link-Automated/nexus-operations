# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""/coding-settings/ on a project: members read, project admins write, outcome columns from the same project."""

import pytest
from rest_framework.test import APIClient

from plane.coding.models import ProjectCodingSettings
from plane.db.models import State

from .conftest import ADMIN, MEMBER, REPO, make_state


@pytest.mark.contract
class TestRead:
    def test_defaults_before_anything_is_set(self, admin, member, project, states, settings_url):
        res = member[1].get(settings_url(project.id))
        assert res.status_code == 200, res.data
        body = res.data
        assert (body["enabled"], body["repo_url"], body["default_branch"], body["configured"]) == (
            False,
            "",
            "main",
            False,
        )
        assert body["ready_state"] is None and body["failed_state"] is None and body["in_review_state"] is None
        # Matched by name, case-insensitively.
        assert body["columns"]["ready"] == {"id": str(states["ready"].id), "name": "ready", "chosen": False}
        assert body["columns"]["in_review"]["name"] == "In Review"
        assert body["columns"]["failed"]["name"] == "Failed"
        assert not ProjectCodingSettings.objects.exists()

    def test_guest_cannot_read(self, guest, project, settings_url):
        assert guest[1].get(settings_url(project.id)).status_code == 403

    def test_missing_column(self, admin, project, states, settings_url):
        states["failed"].delete()
        assert admin[1].get(settings_url(project.id)).data["columns"]["failed"] is None


@pytest.mark.contract
class TestWrite:
    def test_admin_configures_the_project(self, admin, project, states, settings_url):
        shipped = make_state(project, "Shipped")
        body = {
            "enabled": True,
            "repo_url": REPO,
            "default_branch": "develop",
            "ready_state": str(shipped.id),
        }
        res = admin[1].patch(settings_url(project.id), body, format="json")
        assert res.status_code == 200, res.data
        assert res.data["configured"] is True and res.data["default_branch"] == "develop"
        assert res.data["ready_state"] == str(shipped.id)
        assert res.data["columns"]["ready"] == {"id": str(shipped.id), "name": "Shipped", "chosen": True}
        stored = ProjectCodingSettings.objects.get(project=project)
        assert stored.ready_state == shipped and stored.workspace_id == project.workspace_id

        # Only what is sent changes; null goes back to matching by name.
        res = admin[1].patch(settings_url(project.id), {"ready_state": None}, format="json")
        assert res.data["repo_url"] == REPO and res.data["ready_state"] is None
        assert res.data["columns"]["ready"]["name"] == "ready"

    def test_members_and_guests_cannot_write(self, member, guest, project, settings_url):
        for client in (member[1], guest[1]):
            assert client.patch(settings_url(project.id), {"enabled": True}, format="json").status_code == 403
        assert not ProjectCodingSettings.objects.exists()

    def test_workspace_admin_who_is_a_project_member_counts_as_admin(self, make_user, workspace, project, settings_url):
        _, client = make_user(ADMIN, workspace=workspace, project=project, project_role=MEMBER)
        assert client.patch(settings_url(project.id), {"enabled": True}, format="json").status_code == 200

    def test_states_must_be_from_this_project(
        self, admin, project, workspace, create_user, settings_url, other_workspace
    ):
        from plane.db.models import Project, ProjectMember

        sibling = Project.objects.create(name="Sibling", identifier="SIB", workspace=workspace, created_by=create_user)
        ProjectMember.objects.create(project=sibling, member=create_user, role=ADMIN, is_active=True)
        foreign = make_state(sibling, "Ready")
        elsewhere = State.objects.get(project=other_workspace["project"])
        triage = make_state(project, "Triage", group="triage")
        for state in (foreign, elsewhere, triage):
            res = admin[1].patch(settings_url(project.id), {"failed_state": str(state.id)}, format="json")
            assert res.status_code == 400 and "failed_state" in res.data["errors"]
        res = admin[1].patch(settings_url(project.id), {"in_review_state": "not-a-uuid"}, format="json")
        assert res.status_code == 400
        assert not ProjectCodingSettings.objects.filter(project=project).exists()

    @pytest.mark.parametrize(
        "body",
        [
            {"repo_url": "http://github.com/example/app"},
            {"repo_url": "git@github.com:example/app.git"},
            {"repo_url": "javascript:alert(1)"},
            {"default_branch": "bad branch"},
            {"default_branch": "../main"},
            {"default_branch": "-x"},
            {"enabled": "maybe"},
            {"machine": "laptop"},
        ],
    )
    def test_invalid_values(self, admin, project, settings_url, body):
        assert admin[1].patch(settings_url(project.id), body, format="json").status_code == 400

    def test_clearing_the_repo_turns_jobs_off(self, admin, project, settings_url, coding_settings):
        res = admin[1].patch(settings_url(project.id), {"repo_url": ""}, format="json")
        assert res.status_code == 200 and res.data["configured"] is False


@pytest.mark.contract
class TestScope:
    def test_another_workspaces_project_is_404(self, admin, settings_url, other_workspace):
        assert admin[1].get(settings_url(other_workspace["project"].id)).status_code == 404
        res = admin[1].patch(settings_url(other_workspace["project"].id), {"enabled": False}, format="json")
        assert res.status_code == 404
        assert ProjectCodingSettings.objects.get(project=other_workspace["project"]).enabled is True

    def test_outsider_is_refused(self, make_user, project, settings_url, other_workspace):
        _, outsider = make_user(ADMIN, workspace=other_workspace["workspace"])
        assert outsider.get(settings_url(project.id)).status_code == 403

    def test_session_route(self, create_user, project, settings_url):
        client = APIClient()
        client.force_authenticate(user=create_user)
        res = client.patch(settings_url(project.id, base="/api"), {"enabled": True, "repo_url": REPO}, format="json")
        assert res.status_code == 200 and res.data["configured"] is True
        assert client.get(settings_url(project.id, base="/api")).data["configured"] is True
