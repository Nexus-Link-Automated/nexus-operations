# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Step 7: EmployAI agents as bot members. Admins create them with a role and a token; they work through the public
API only, are managed and removed like any member, and their coding jobs run on their own machines."""

import pytest
from rest_framework.test import APIClient

from plane.coding import machines
from plane.coding.models import CodingJob, JobStatus, MachineState
from plane.db.models import APIToken, ProjectMember, User, WorkspaceMember
from plane.db.models.api import AGENT_SESSION_TOKEN_LABEL
from plane.middleware.logger import APITokenLogMiddleware

from .conftest import ADMIN, GUEST, MEMBER, make_issue
from .test_dispatch import READY, _reset_machine_throttles, beat, report  # noqa: F401


def token_client(token: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_X_API_KEY=token)
    return client


def session(user) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.fixture
def bots_url(workspace):
    def url(suffix="", base="/api/v1"):
        return f"{base}/workspaces/{workspace.slug}/bot-members/{suffix}"

    return url


@pytest.fixture
def make_bot(admin, bots_url):
    def make(name="Triage agent", role=MEMBER, **extra):
        res = admin[1].post(bots_url(), {"name": name, "role": role, **extra}, format="json")
        assert res.status_code == 201, res.content
        return res.json()

    return make


@pytest.mark.contract
class TestCreating:
    def test_admin_creates_a_bot_with_a_role_and_a_token_shown_once(self, make_bot, admin, bots_url, workspace):
        body = make_bot(description="Sorts new bugs")
        assert body["name"] == "Triage agent" and body["role"] == MEMBER and body["is_active"]
        assert body["token"] and body["description"] == "Sorts new bugs"
        user = User.objects.get(pk=body["id"])
        assert user.is_bot and user.bot_type == "EMPLOYAI" and not user.has_usable_password()
        assert user.email.endswith(".invalid")
        assert WorkspaceMember.objects.get(workspace=workspace, member=user).role == MEMBER
        # Its token works on the public API, in this workspace only.
        token = APIToken.objects.get(token=body["token"])
        assert token.workspace_id == workspace.id and token.user_type == 1
        assert token_client(body["token"]).get(f"/api/v1/workspaces/{workspace.slug}/projects/").status_code == 200
        # Never shown again.
        listed = admin[1].get(bots_url()).json()
        assert [b["id"] for b in listed] == [body["id"]] and "token" not in listed[0]

    def test_the_token_is_not_kept_in_the_request_log(self):
        logged = APITokenLogMiddleware(None)._redact_response("/api/v1/workspaces/w/bot-members/", '{"token": "plane_x"}')
        assert "plane_x" not in logged

    def test_who_may_create(self, member, make_bot, bots_url, admin, create_user, workspace):
        assert member[1].post(bots_url(), {"name": "x"}, format="json").status_code == 403
        bot = make_bot()
        res = token_client(bot["token"]).post(bots_url(), {"name": "y"}, format="json")
        assert res.status_code == 403 and res.json()["code"] == "BOT_NOT_ALLOWED"
        agent = APIToken.objects.create(user=create_user, label=AGENT_SESSION_TOKEN_LABEL, workspace=workspace)
        res = token_client(agent.token).post(bots_url(), {"name": "z"}, format="json")
        assert res.status_code == 403 and res.json()["code"] == "AGENT_SESSION_NOT_ALLOWED"

    def test_never_an_admin(self, admin, bots_url):
        assert admin[1].post(bots_url(), {"name": "x", "role": ADMIN}, format="json").status_code == 400

    def test_web_routes(self, create_user, bots_url):
        res = session(create_user).post(bots_url(base="/api"), {"name": "Web bot"}, format="json")
        assert res.status_code == 201 and res.json()["token"]


@pytest.mark.contract
class TestLikeAnyMember:
    def test_listed_with_the_members_and_added_to_projects(self, make_bot, create_user, workspace, project):
        bot = make_bot()
        admin = session(create_user)
        members = admin.get(f"/api/workspaces/{workspace.slug}/members/").json()
        listed = [m for m in members if m["member"]["id"] == bot["id"]]
        assert listed and listed[0]["member"]["is_bot"] is True
        res = admin.post(
            f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/",
            {"members": [{"member_id": bot["id"], "role": MEMBER}]},
            format="json",
        )
        assert res.status_code == 201, res.content
        project_members = admin.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/members/").json()
        assert bot["id"] in [m["member"] for m in project_members]

    def test_role_changes(self, make_bot, admin, bots_url, project, workspace):
        bot = make_bot()
        ProjectMember.objects.create(project=project, member_id=bot["id"], role=MEMBER, is_active=True)
        res = admin[1].patch(bots_url(f"{bot['id']}/"), {"role": GUEST, "name": "Renamed"}, format="json")
        assert res.status_code == 200 and res.json()["role"] == GUEST and res.json()["name"] == "Renamed"
        assert ProjectMember.objects.get(project=project, member_id=bot["id"]).role == GUEST

    def test_removed_from_the_members_list_like_anyone(self, make_bot, create_user, workspace, project):
        bot = make_bot()
        ProjectMember.objects.create(project=project, member_id=bot["id"], role=MEMBER, is_active=True)
        membership = WorkspaceMember.objects.get(workspace=workspace, member_id=bot["id"])
        res = session(create_user).delete(f"/api/workspaces/{workspace.slug}/members/{membership.id}/")
        assert res.status_code == 204, res.content
        assert not ProjectMember.objects.get(project=project, member_id=bot["id"]).is_active
        # Its token stopped working.
        assert token_client(bot["token"]).get(f"/api/v1/workspaces/{workspace.slug}/projects/").status_code in (
            401,
            403,
        )

    def test_removed_through_the_bot_endpoint(self, make_bot, admin, bots_url, workspace):
        bot = make_bot()
        assert admin[1].delete(bots_url(f"{bot['id']}/")).status_code == 204
        assert not WorkspaceMember.objects.get(workspace=workspace, member_id=bot["id"]).is_active
        assert not APIToken.objects.filter(user_id=bot["id"], is_active=True).exists()
        assert admin[1].get(bots_url(f"{bot['id']}/")).json()["is_active"] is False
        assert admin[1].post(bots_url(f"{bot['id']}/token/")).status_code == 409

    def test_new_token(self, make_bot, admin, bots_url, workspace):
        bot = make_bot()
        res = admin[1].post(bots_url(f"{bot['id']}/token/"))
        assert res.status_code == 201
        fresh = res.json()["token"]
        assert fresh != bot["token"]
        projects = f"/api/v1/workspaces/{workspace.slug}/projects/"
        assert token_client(bot["token"]).get(projects).status_code in (401, 403)
        assert token_client(fresh).get(projects).status_code == 200

    def test_at_most_twenty(self, admin, bots_url):
        for index in range(20):
            assert admin[1].post(bots_url(), {"name": f"b{index}"}, format="json").status_code == 201
        res = admin[1].post(bots_url(), {"name": "one more"}, format="json")
        assert res.status_code == 409 and res.json()["code"] == "BOT_LIMIT"


@pytest.mark.contract
class TestTheBotsMachines:
    def machines_url(self, workspace, suffix=""):
        return f"/api/v1/workspaces/{workspace.slug}/coding-machines/{suffix}"

    def test_an_admin_adds_and_approves_a_machine_for_a_bot(self, make_bot, admin, member, workspace):
        bot = make_bot()
        res = admin[1].post(self.machines_url(workspace), {"name": "Agent box", "owner": bot["id"]}, format="json")
        assert res.status_code == 201, res.content
        body = res.json()
        assert body["owner"] == bot["id"] and body["owner_is_bot"] is True and body["join_code"]
        machine, _ = machines.join(body["join_code"], hostname="box")
        # Not the bot, not a member: an admin approves it.
        bot_client = token_client(bot["token"])
        assert bot_client.post(self.machines_url(workspace, f"{machine.id}/approve/")).status_code == 403
        assert member[1].post(self.machines_url(workspace, f"{machine.id}/approve/")).status_code == 404
        res = admin[1].post(self.machines_url(workspace, f"{machine.id}/approve/"))
        assert res.status_code == 200 and res.json()["state"] == MachineState.ACTIVE

    def test_a_bot_cannot_add_machines(self, make_bot, workspace):
        bot = make_bot()
        res = token_client(bot["token"]).post(self.machines_url(workspace), {"name": "mine"}, format="json")
        assert res.status_code == 403 and res.json()["code"] == "BOT_NOT_ALLOWED"

    def test_only_for_a_bot_member_who_is_not_a_guest(self, make_bot, admin, member, workspace):
        guest_bot = make_bot(role=GUEST)
        for owner in (guest_bot["id"], str(member[0].id)):
            res = admin[1].post(self.machines_url(workspace), {"name": "x", "owner": owner}, format="json")
            assert res.status_code == 400 and res.json()["code"] == "BOT_NOT_FOUND"
        assert (
            member[1]
            .post(self.machines_url(workspace), {"name": "x", "owner": guest_bot["id"]}, format="json")
            .status_code
            == 403
        )

    def test_a_bots_jobs_run_on_its_own_machines_only(
        self, make_bot, admin, create_user, workspace, project, coding_settings, tasks
    ):
        bot = make_bot()
        ProjectMember.objects.create(project=project, member_id=bot["id"], role=MEMBER, is_active=True)
        # The admin's own machine, and the bot's.
        _, mine = machines.join(machines.add_machine(workspace, create_user, "Admin laptop")[1], hostname="a")
        my_machine = machines.authenticate_key(mine)
        machines.approve(my_machine)
        bot_user = User.objects.get(pk=bot["id"])
        bot_machine, bot_key = machines.join(machines.add_machine(workspace, bot_user, "Agent box")[1], hostname="b")
        machines.approve(bot_machine)
        issue = make_issue(project)
        res = token_client(bot["token"]).post(
            f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/work-items/{issue.id}/coding-jobs/",
            {"action": "fix_bug", "agent": "codex"},
            format="json",
        )
        assert res.status_code == 201, res.content
        job_id = res.json()["id"]
        assert beat(mine, report(agents=(READY,))).json()["jobs"] == []
        handed = beat(bot_key, report(agents=(READY,))).json()["jobs"]
        assert [job["id"] for job in handed] == [job_id]
        assert CodingJob.objects.get(pk=job_id).status == JobStatus.RUNNING
