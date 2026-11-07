# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Chat follows Plane's workspace membership: a guest's DM grant ends when they stop being an active guest, and
the gateway is told when someone's access ends."""

import pytest
from crum import set_current_user

from plane.chat.models import ChatGuestPermission
from plane.db.models import WorkspaceMember
from plane.tests.factories import WorkspaceFactory

GUEST, MEMBER = 5, 15


@pytest.fixture
def guest_membership(workspace, make_member):
    user = make_member(role=GUEST)
    ChatGuestPermission.objects.create(workspace=workspace, user=user, can_open_dms=True)
    return WorkspaceMember.objects.get(workspace=workspace, member=user)


def _granted(membership):
    return ChatGuestPermission.objects.filter(
        workspace_id=membership.workspace_id, user_id=membership.member_id, can_open_dms=True
    ).exists()


@pytest.mark.unit
@pytest.mark.django_db
class TestRevokeGuestGrants:
    def test_promotion_revokes_and_demotion_does_not_restore(self, guest_membership):
        guest_membership.role = MEMBER
        guest_membership.save(update_fields=["role", "updated_at"])
        assert not _granted(guest_membership)
        guest_membership.role = GUEST
        guest_membership.save()
        assert not _granted(guest_membership)

    def test_deactivation_revokes(self, guest_membership):
        guest_membership.is_active = False
        guest_membership.save()
        assert not _granted(guest_membership)

    def test_removal_revokes(self, guest_membership):
        guest_membership.delete()
        assert not _granted(guest_membership)

    def test_other_saves_keep_the_grant(self, guest_membership):
        guest_membership.view_props = {"x": 1}
        guest_membership.save(update_fields=["view_props"])
        guest_membership.save()
        assert _granted(guest_membership)

    def test_only_that_workspace(self, guest_membership, make_member):
        elsewhere = WorkspaceFactory()
        WorkspaceMember.objects.create(workspace=elsewhere, member=guest_membership.member, role=MEMBER)
        assert _granted(guest_membership)


@pytest.fixture
def membership(workspace, make_member):
    return WorkspaceMember.objects.get(workspace=workspace, member=make_member(role=MEMBER))


@pytest.mark.unit
@pytest.mark.django_db
class TestPublishAccessRevoked:
    def _revoked(self, membership):
        return {
            "type": "access.revoked",
            "workspace_id": str(membership.workspace_id),
            "user_id": str(membership.member_id),
        }

    def test_deactivation_publishes(self, membership, redis, django_capture_on_commit_callbacks):
        with django_capture_on_commit_callbacks(execute=True):
            membership.is_active = False
            membership.save()
        assert redis.events == [self._revoked(membership)]

    def test_removal_publishes(self, membership, redis, django_capture_on_commit_callbacks):
        with django_capture_on_commit_callbacks(execute=True):
            membership.delete()
        assert redis.events == [self._revoked(membership)]

    def test_leaving_with_only_the_active_flag_written_publishes(
        self, membership, redis, django_capture_on_commit_callbacks
    ):
        with django_capture_on_commit_callbacks(execute=True):
            membership.is_active = False
            membership.save(update_fields=["is_active", "updated_at"])
        assert redis.events == [self._revoked(membership)]

    def test_it_names_who_did_it(self, membership, workspace, make_member, redis, django_capture_on_commit_callbacks):
        admin = make_member(role=20)
        set_current_user(admin)
        try:
            with django_capture_on_commit_callbacks(execute=True):
                membership.is_active = False
                membership.save()
        finally:
            set_current_user(None)
        assert redis.events == [self._revoked(membership) | {"actor_id": str(admin.id)}]

    @pytest.mark.parametrize(
        "change",
        [
            {"role": GUEST, "update_fields": ["role", "updated_at"]},  # a demotion narrows access; the timer covers it
            {"view_props": {"x": 1}, "update_fields": ["view_props"]},
            {"update_fields": None},  # a plain save of an active member
        ],
    )
    def test_other_saves_publish_nothing(self, membership, redis, django_capture_on_commit_callbacks, change):
        update_fields = change.pop("update_fields")
        with django_capture_on_commit_callbacks(execute=True):
            for field, value in change.items():
                setattr(membership, field, value)
            membership.save(update_fields=update_fields)
        assert redis.events == []

    def test_joining_publishes_nothing(self, workspace, make_member, redis, django_capture_on_commit_callbacks):
        with django_capture_on_commit_callbacks(execute=True):
            make_member(role=MEMBER)
        assert redis.events == []
