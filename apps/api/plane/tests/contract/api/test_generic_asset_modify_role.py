# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for who may update an asset through the external-API ``GenericAssetEndpoint``.

``patch`` follows ``can_modify_asset``, the rule the app asset endpoints use: the
workspace logo needs a workspace admin, a project cover a project admin, an issue
attachment a project admin or its uploader, and any other asset a member, an admin
or its uploader.
"""

from uuid import uuid4

import pytest
from rest_framework import status

from plane.db.models import FileAsset, Project, ProjectMember, User, WorkspaceMember

ADMIN, MEMBER, GUEST = 20, 15, 5


def _asset_url(workspace, asset):
    return f"/api/v1/workspaces/{workspace.slug}/assets/{asset.id}/"


def _asset(workspace, creator, entity_type, project=None):
    asset = FileAsset(
        attributes={"name": "file.pdf", "type": "application/pdf", "size": 1024},
        asset=f"{workspace.id}/{uuid4().hex}-file.pdf",
        size=1024,
        workspace=workspace,
        project=project,
        entity_type=entity_type,
        is_uploaded=True,
        storage_metadata={"size": 1024},
    )
    asset.save(created_by_id=creator.id)
    return asset


def _set_roles(workspace, user, workspace_role, project=None, project_role=None):
    WorkspaceMember.objects.filter(workspace=workspace, member=user).update(role=workspace_role)
    if project is not None:
        ProjectMember.objects.update_or_create(
            project=project,
            member=user,
            defaults={"workspace": workspace, "role": project_role, "is_active": True},
        )


def _assert_refused(client, workspace, asset):
    response = client.patch(_asset_url(workspace, asset), {"is_uploaded": False}, format="json")
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.data
    asset.refresh_from_db()
    assert asset.is_uploaded is True


def _assert_allowed(client, workspace, asset):
    response = client.patch(_asset_url(workspace, asset), {"is_uploaded": False}, format="json")
    assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
    asset.refresh_from_db()
    assert asset.is_uploaded is False


@pytest.fixture
def project(db, workspace):
    return Project.objects.create(name="Assets", identifier="AST", workspace=workspace)


@pytest.fixture
def uploader(db, workspace, project):
    """Another active project member, who uploaded the assets the token holder may not own."""
    unique_id = uuid4().hex[:8]
    user = User.objects.create(email=f"uploader-{unique_id}@plane.so", username=f"uploader_{unique_id}")
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=MEMBER)
    ProjectMember.objects.create(project=project, member=user, workspace=workspace, role=MEMBER, is_active=True)
    return user


@pytest.mark.contract
@pytest.mark.django_db
class TestGenericAssetModifyRole:
    def test_attachment_needs_a_project_admin_or_its_uploader(
        self, api_key_client, workspace, project, uploader, create_user
    ):
        attachment = FileAsset.EntityTypeContext.ISSUE_ATTACHMENT

        _set_roles(workspace, create_user, GUEST, project, GUEST)
        _assert_refused(api_key_client, workspace, _asset(workspace, uploader, attachment, project))
        _assert_allowed(api_key_client, workspace, _asset(workspace, create_user, attachment, project))

        _set_roles(workspace, create_user, MEMBER, project, MEMBER)
        _assert_refused(api_key_client, workspace, _asset(workspace, uploader, attachment, project))

        _set_roles(workspace, create_user, MEMBER, project, ADMIN)
        _assert_allowed(api_key_client, workspace, _asset(workspace, uploader, attachment, project))

    def test_other_project_asset_needs_a_member_or_its_uploader(
        self, api_key_client, workspace, project, uploader, create_user
    ):
        description = FileAsset.EntityTypeContext.ISSUE_DESCRIPTION

        _set_roles(workspace, create_user, GUEST, project, GUEST)
        _assert_refused(api_key_client, workspace, _asset(workspace, uploader, description, project))
        _assert_allowed(api_key_client, workspace, _asset(workspace, create_user, description, project))

        _set_roles(workspace, create_user, MEMBER, project, MEMBER)
        _assert_allowed(api_key_client, workspace, _asset(workspace, uploader, description, project))

    def test_project_cover_needs_a_project_admin(self, api_key_client, workspace, project, create_user):
        cover = FileAsset.EntityTypeContext.PROJECT_COVER

        _set_roles(workspace, create_user, MEMBER, project, MEMBER)
        _assert_refused(api_key_client, workspace, _asset(workspace, create_user, cover, project))

        _set_roles(workspace, create_user, MEMBER, project, ADMIN)
        _assert_allowed(api_key_client, workspace, _asset(workspace, create_user, cover, project))

    def test_workspace_logo_needs_a_workspace_admin(self, api_key_client, workspace, create_user):
        logo = FileAsset.EntityTypeContext.WORKSPACE_LOGO

        _set_roles(workspace, create_user, MEMBER)
        _assert_refused(api_key_client, workspace, _asset(workspace, create_user, logo))

        _set_roles(workspace, create_user, ADMIN)
        _assert_allowed(api_key_client, workspace, _asset(workspace, create_user, logo))
