# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Profile sync on sign-in must handle a missing avatar and keep the stored one until it is replaced."""

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from django.test import RequestFactory

from plane.authentication.adapter.base import Adapter
from plane.db.models import FileAsset, User

AVATAR_URL = "https://avatars.example.com/u/1.png"


@pytest.fixture
def user(db):
    return User.objects.create(email=f"sync-{uuid4().hex[:8]}@example.com", username=uuid4().hex)


@pytest.fixture
def stored_avatar(user):
    asset = FileAsset.objects.create(
        asset=f"{uuid4().hex}-user-avatar.png",
        user=user,
        entity_type=FileAsset.EntityTypeContext.USER_AVATAR,
        is_uploaded=True,
    )
    user.avatar_asset = asset
    user.save()
    return asset


@pytest.fixture
def storage():
    with patch("plane.authentication.adapter.base.S3Storage") as storage_class:
        yield storage_class.return_value


def sign_in(user, avatar, new_asset=None):
    adapter = Adapter(request=RequestFactory().get("/", HTTP_USER_AGENT="pytest"), provider="google")
    adapter.set_user_data(
        {
            "email": user.email,
            "user": {"first_name": "Ada", "last_name": "L", "avatar": avatar, "is_password_autoset": True},
        }
    )
    with (
        patch.object(Adapter, "check_sync_enabled", return_value=True),
        patch.object(Adapter, "download_and_upload_avatar", MagicMock(return_value=new_asset)) as upload,
    ):
        signed_in = adapter.complete_login_or_signup()
    signed_in.refresh_from_db()
    return signed_in, upload


@pytest.mark.unit
@pytest.mark.django_db
class TestAvatarSync:
    def test_provider_without_avatar_signs_in(self, user, storage):
        signed_in, _ = sign_in(user, avatar=None)

        assert signed_in.avatar == ""
        assert signed_in.first_name == "Ada"

    def test_provider_without_avatar_keeps_the_stored_avatar(self, user, stored_avatar, storage):
        signed_in, _ = sign_in(user, avatar=None)

        assert signed_in.avatar_asset_id == stored_avatar.id
        assert FileAsset.objects.filter(pk=stored_avatar.pk).exists()
        storage.delete_files.assert_not_called()

    def test_failed_upload_keeps_the_stored_avatar(self, user, stored_avatar, storage):
        signed_in, upload = sign_in(user, avatar=AVATAR_URL, new_asset=None)

        upload.assert_called_once()
        assert signed_in.avatar_asset_id == stored_avatar.id
        assert signed_in.avatar == AVATAR_URL
        assert FileAsset.objects.filter(pk=stored_avatar.pk).exists()
        storage.delete_files.assert_not_called()

    def test_successful_upload_replaces_the_stored_avatar(self, user, stored_avatar, storage):
        new_asset = FileAsset.objects.create(
            asset=f"{uuid4().hex}-user-avatar.png",
            user=user,
            entity_type=FileAsset.EntityTypeContext.USER_AVATAR,
            is_uploaded=True,
        )

        signed_in, _ = sign_in(user, avatar=AVATAR_URL, new_asset=new_asset)

        assert signed_in.avatar_asset_id == new_asset.id
        assert not FileAsset.objects.filter(pk=stored_avatar.pk).exists()
        storage.delete_files.assert_called_once_with(object_names=[stored_avatar.asset.name])
