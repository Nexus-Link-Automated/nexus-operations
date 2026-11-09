# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Issue history and comment lists must not query per row for avatars, logos or covers.

Each row serializes ``actor_detail.avatar_url``, ``workspace_detail.logo_url`` and
``project_detail.cover_image_url``. Those properties read a ``*_asset`` foreign key, so the
asset has to be loaded with the row or every asset-backed value costs another query.
"""

from uuid import uuid4

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework import status

from plane.db.models import (
    CommentReaction,
    FileAsset,
    Issue,
    IssueActivity,
    IssueComment,
    Project,
    ProjectMember,
    State,
    User,
)

LIST_PATHS = [
    "history/",
    "history/?activity_type=issue-property",
    "history/?activity_type=issue-comment",
    "comments/",
]


def make_asset(workspace, entity_type):
    return FileAsset.objects.create(
        workspace=workspace,
        asset=f"{workspace.id}/{uuid4().hex}.png",
        size=1024,
        entity_type=entity_type,
        is_uploaded=True,
    )


def make_actor(**fields):
    suffix = uuid4().hex[:8]
    return User.objects.create(email=f"actor-{suffix}@plane.so", username=f"actor_{suffix}", **fields)


def make_avatar_actor(workspace):
    return make_actor(avatar_asset=make_asset(workspace, FileAsset.EntityTypeContext.USER_AVATAR))


def add_rows(issue, actor):
    """One activity and one reacted-to comment by ``actor``: the rows both list views serialize."""
    scope = {"issue": issue, "project": issue.project, "workspace": issue.workspace, "actor": actor}
    IssueActivity.objects.create(verb="updated", field="state", **scope)
    comment = IssueComment.objects.create(comment_html="<p>hi</p>", **scope)
    CommentReaction.objects.create(
        comment=comment, project=issue.project, workspace=issue.workspace, actor=actor, reaction="128077"
    )


def static_url(asset):
    return f"/api/assets/v2/static/{asset.id}/"


@pytest.fixture
def project(db, workspace, create_user):
    workspace.logo_asset = make_asset(workspace, FileAsset.EntityTypeContext.WORKSPACE_LOGO)
    workspace.save()
    project = Project.objects.create(
        name="Query Count",
        identifier="QC",
        workspace=workspace,
        created_by=create_user,
        cover_image_asset=make_asset(workspace, FileAsset.EntityTypeContext.PROJECT_COVER),
    )
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def issue(db, workspace, project, create_user):
    state = State.objects.create(name="Todo", project=project, workspace=workspace, group="backlog", default=True)
    return Issue.objects.create(name="I", workspace=workspace, project=project, state=state, created_by=create_user)


@pytest.fixture
def url(workspace, project, issue):
    return lambda path: f"/api/workspaces/{workspace.slug}/projects/{project.id}/issues/{issue.id}/{path}"


@pytest.mark.contract
@pytest.mark.django_db
class TestIssueActivityCommentAssetLookups:
    @pytest.mark.parametrize("path", LIST_PATHS)
    def test_query_count_does_not_grow_with_rows(self, session_client, workspace, issue, url, path):
        def fetch():
            with CaptureQueriesContext(connection) as ctx:
                response = session_client.get(url(path))
            assert response.status_code == status.HTTP_200_OK
            return len(ctx.captured_queries), len(response.data)

        for _ in range(2):
            add_rows(issue, make_avatar_actor(workspace))
        # Per-process caches fill on the first request; keep them out of the baseline.
        fetch()
        few_queries, few_rows = fetch()

        for _ in range(6):
            add_rows(issue, make_avatar_actor(workspace))
        many_queries, many_rows = fetch()

        assert many_rows > few_rows
        assert many_queries == few_queries

    @pytest.mark.parametrize("path", LIST_PATHS)
    def test_asset_urls_stay_correct(self, session_client, workspace, project, issue, url, path):
        asset_actor = make_avatar_actor(workspace)
        url_actor = make_actor(avatar="https://example.com/avatar.png")
        plain_actor = make_actor()
        actors = {
            str(asset_actor.id): (asset_actor, static_url(asset_actor.avatar_asset)),
            str(url_actor.id): (url_actor, "https://example.com/avatar.png"),
            str(plain_actor.id): (plain_actor, None),
        }
        for actor, _ in actors.values():
            add_rows(issue, actor)

        response = session_client.get(url(path))

        assert response.status_code == status.HTTP_200_OK
        assert {str(row["actor_detail"]["id"]) for row in response.data} == set(actors)
        for row in response.data:
            actor, avatar_url = actors[str(row["actor_detail"]["id"])]
            assert row["actor_detail"]["avatar_url"] == avatar_url
            assert row["workspace_detail"]["logo_url"] == static_url(workspace.logo_asset)
            assert row["project_detail"]["cover_image_url"] == static_url(project.cover_image_asset)
            if "comment_reactions" in row:
                assert [reaction["display_name"] for reaction in row["comment_reactions"]] == [actor.display_name]
