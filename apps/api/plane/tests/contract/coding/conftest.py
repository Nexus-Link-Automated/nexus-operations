# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Fixtures for the coding-job contract tests.

The default `create_user` is a workspace admin and project admin. The project has the states the outcome columns
match by name (Ready, Failed, In review) besides its default Todo, and coding jobs set up.
"""

from unittest import mock
from uuid import uuid4

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from plane.coding import machines
from plane.coding.models import CodingJob, MachineState, ProjectCodingSettings
from plane.db.models import Issue, Project, ProjectMember, State, User, Workspace, WorkspaceMember
from plane.db.models.api import APIToken

ADMIN, MEMBER, GUEST = 20, 15, 5
REPO = "https://github.com/example/app"


@pytest.fixture(autouse=True)
def _reset_api_key_throttle_cache():
    cache.delete_pattern("api_key:*")
    yield
    cache.delete_pattern("api_key:*")


def client_for(user) -> APIClient:
    token = APIToken.objects.create(user=user, label="test", token=f"tok-{uuid4().hex}")
    client = APIClient()
    client.credentials(HTTP_X_API_KEY=token.token)
    return client


def make_state(project, name, group="started", **extra):
    return State.objects.create(name=name, group=group, project=project, workspace=project.workspace, **extra)


def make_issue(project, name="Login breaks", **extra):
    return Issue.objects.create(name=name, project=project, workspace=project.workspace, **extra)


@pytest.fixture
def make_user(db):
    def make(role=MEMBER, workspace=None, project=None, project_role=None, name=""):
        user = User.objects.create(
            email=f"{uuid4().hex[:10]}@example.com", username=uuid4().hex[:12], display_name=name or uuid4().hex[:6]
        )
        if workspace is not None:
            WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
        if project is not None:
            ProjectMember.objects.create(project=project, member=user, role=project_role or role, is_active=True)
        return user, client_for(user)

    return make


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="App", identifier="APP", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, role=ADMIN, is_active=True)
    make_state(project, "Todo", group="unstarted", default=True)
    make_state(project, "In Review")
    make_state(project, "ready", group="unstarted")
    make_state(project, "Failed")
    return project


@pytest.fixture
def states(project):
    return {state.name.lower(): state for state in State.objects.filter(project=project)}


@pytest.fixture
def coding_settings(project):
    return ProjectCodingSettings.objects.create(project=project, enabled=True, repo_url=REPO)


@pytest.fixture
def issue(project, states):
    return make_issue(project, state=states["todo"])


@pytest.fixture
def admin(create_user, api_key_client):
    return create_user, api_key_client


@pytest.fixture
def member(make_user, workspace, project):
    return make_user(MEMBER, workspace=workspace, project=project, name="Mia Member")


@pytest.fixture
def guest(make_user, workspace, project):
    return make_user(GUEST, workspace=workspace, project=project)


@pytest.fixture
def other_workspace(db):
    owner = User.objects.create(email=f"{uuid4().hex[:8]}@x.com", username=uuid4().hex[:12])
    workspace = Workspace.objects.create(name="Other", slug=f"other-{uuid4().hex[:6]}", owner=owner)
    WorkspaceMember.objects.create(workspace=workspace, member=owner, role=ADMIN)
    project = Project.objects.create(name="Other", identifier="OTH", workspace=workspace, created_by=owner)
    ProjectMember.objects.create(project=project, member=owner, role=ADMIN, is_active=True)
    make_state(project, "Todo", group="unstarted", default=True)
    ProjectCodingSettings.objects.create(project=project, enabled=True, repo_url=REPO)
    issue = make_issue(project, "Other item")
    job = CodingJob.objects.create(issue=issue, action="fix_bug", agent="codex", requested_by=owner)
    return {"workspace": workspace, "project": project, "issue": issue, "job": job, "owner": owner}


@pytest.fixture
def jobs_url(workspace):
    def url(project_id, issue_id, suffix="", base="/api/v1"):
        return f"{base}/workspaces/{workspace.slug}/projects/{project_id}/work-items/{issue_id}/coding-jobs/{suffix}"

    return url


@pytest.fixture
def settings_url(workspace):
    def url(project_id, base="/api/v1"):
        return f"{base}/workspaces/{workspace.slug}/projects/{project_id}/coding-settings/"

    return url


@pytest.fixture
def tasks(django_capture_on_commit_callbacks):
    """Records the activity tasks the outcome service queues instead of sending them.

    Wrap a call in `with tasks.commit():` to run what it queues on commit, as the request would.
    """

    class Tasks:
        def __init__(self):
            self.issue_activity = mock.MagicMock()
            self.model_activity = mock.MagicMock()

        def commit(self):
            return django_capture_on_commit_callbacks(execute=True)

        def activity_types(self):
            return [call.kwargs["type"] for call in self.issue_activity.delay.call_args_list]

    recorded = Tasks()
    with (
        mock.patch("plane.coding.outcomes.issue_activity", recorded.issue_activity),
        mock.patch("plane.coding.outcomes.model_activity", recorded.model_activity),
    ):
        yield recorded


@pytest.fixture
def make_machine(workspace):
    """An approved machine of `owner` and its key."""

    def make(owner, name="Laptop", state=MachineState.ACTIVE):
        machine, code = machines.add_machine(workspace, owner, name)
        machine, key = machines.join(code, hostname=name.lower())
        if state == MachineState.ACTIVE:
            machine = machines.approve(machine)
        return machine, key

    return make


@pytest.fixture
def start(issue, coding_settings):
    def start_job(user, action="fix_bug", agent="codex", machine=None, item=None):
        return CodingJob.objects.create(
            issue=item or issue, action=action, agent=agent, requested_by=user, machine=machine
        )

    return start_job


@pytest.fixture
def other_member(make_user, workspace, project):
    return make_user(MEMBER, workspace=workspace, project=project, name="Otto Other")
