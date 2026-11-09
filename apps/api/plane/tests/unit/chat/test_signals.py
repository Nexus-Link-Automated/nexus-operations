# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A guest's DM grant ends when they stop being an active guest, and channel seats when they leave the workspace."""

import pytest

from plane.chat.models import Channel, ChannelKind, ChannelMember, ChannelMemberRole, ChatGuestPermission
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


@pytest.mark.unit
@pytest.mark.django_db
class TestLeavingTheWorkspace:
    @pytest.fixture
    def membership(self, workspace, make_member):
        user = make_member(role=MEMBER)
        return WorkspaceMember.objects.get(workspace=workspace, member=user)

    @pytest.fixture
    def seats(self, workspace, make_member, membership):
        """`membership`'s user in a public channel, a private channel and a DM."""
        user = membership.member
        public = Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="general")
        private = Channel.objects.create(workspace=workspace, kind=ChannelKind.PRIVATE, name="secret")
        for channel in (public, private):
            ChannelMember.objects.create(channel=channel, user=user)
        dm, _ = Channel.objects.get_or_create_dm(workspace, user, make_member())
        return public, private, dm

    def _channels_of(self, user):
        return set(ChannelMember.objects.filter(user=user).values_list("channel_id", flat=True))

    def test_deactivation_ends_named_channels_but_not_dms(self, membership, seats):
        membership.is_active = False
        membership.save()
        assert self._channels_of(membership.member) == {seats[2].id}

    def test_removal_ends_named_channels_but_not_dms(self, membership, seats):
        membership.delete()
        assert self._channels_of(membership.member) == {seats[2].id}

    def test_role_changes_and_other_saves_keep_channels(self, membership, seats):
        membership.role = GUEST
        membership.save(update_fields=["role", "updated_at"])
        membership.view_props = {"x": 1}
        membership.save()
        assert self._channels_of(membership.member) == {channel.id for channel in seats}

    def test_only_that_workspace(self, membership, seats):
        elsewhere = WorkspaceFactory()
        WorkspaceMember.objects.create(workspace=elsewhere, member=membership.member, role=MEMBER)
        other = Channel.objects.create(workspace=elsewhere, kind=ChannelKind.PUBLIC, name="general")
        ChannelMember.objects.create(channel=other, user=membership.member)

        membership.is_active = False
        membership.save()

        assert self._channels_of(membership.member) == {seats[2].id, other.id}

    def test_account_deactivation_ends_channels_and_grants_everywhere(self, workspace, membership, seats):
        """Plane deactivates the memberships with `bulk_update`, which sends no signal, then saves the user."""
        user = membership.member
        ChatGuestPermission.objects.create(workspace=workspace, user=user, can_open_dms=True)

        user.is_active = False
        user.save()

        assert self._channels_of(user) == {seats[2].id}
        assert not _granted(membership)

    def test_other_saves_of_the_user_change_nothing(self, workspace, membership, seats):
        user = membership.member
        ChatGuestPermission.objects.create(workspace=workspace, user=user, can_open_dms=True)

        user.first_name = "Renamed"
        user.save()

        assert self._channels_of(user) == {channel.id for channel in seats}
        assert _granted(membership)


@pytest.mark.unit
@pytest.mark.django_db
class TestPrivateChannelHandover:
    """When a private channel's only admin leaves the workspace, someone still in it takes over."""

    @pytest.fixture
    def leaver(self, workspace, make_member):
        return WorkspaceMember.objects.get(workspace=workspace, member=make_member(role=MEMBER))

    @pytest.fixture
    def private(self, workspace, leaver):
        channel = Channel.objects.create(workspace=workspace, kind=ChannelKind.PRIVATE, name="secret")
        ChannelMember.objects.create(channel=channel, user=leaver.member, role=ChannelMemberRole.ADMIN)
        return channel

    def _add(self, channel, *users, role=ChannelMemberRole.MEMBER):
        for user in users:
            ChannelMember.objects.create(channel=channel, user=user, role=role)

    def _admins(self, channel):
        return set(
            ChannelMember.objects.filter(channel=channel, role=ChannelMemberRole.ADMIN).values_list(
                "user_id", flat=True
            )
        )

    def _leave(self, membership):
        membership.is_active = False
        membership.save()

    def test_the_longest_standing_member_takes_over(self, make_member, leaver, private):
        first, second = make_member(role=MEMBER), make_member(role=MEMBER)
        self._add(private, first, second)
        self._leave(leaver)
        assert self._admins(private) == {first.id}

    def test_a_member_is_preferred_to_a_guest_who_has_been_there_longer(self, make_member, leaver, private):
        guest, colleague = make_member(role=GUEST), make_member(role=MEMBER)
        self._add(private, guest, colleague)
        self._leave(leaver)
        assert self._admins(private) == {colleague.id}

    def test_a_guest_takes_over_when_only_guests_remain(self, make_member, leaver, private):
        first, second = make_member(role=GUEST), make_member(role=GUEST)
        self._add(private, first, second)
        self._leave(leaver)
        assert self._admins(private) == {first.id}

    def test_nobody_is_promoted_while_another_admin_remains(self, make_member, leaver, private):
        other_admin, colleague = make_member(role=MEMBER), make_member(role=MEMBER)
        self._add(private, colleague)
        self._add(private, other_admin, role=ChannelMemberRole.ADMIN)
        self._leave(leaver)
        assert self._admins(private) == {other_admin.id}

    def test_someone_no_longer_in_the_workspace_is_not_chosen(self, workspace, make_member, leaver, private):
        gone, stays = make_member(role=MEMBER), make_member(role=MEMBER)
        self._add(private, gone, stays)
        WorkspaceMember.objects.filter(workspace=workspace, member=gone).update(is_active=False)
        self._leave(leaver)
        assert self._admins(private) == {stays.id}

    def test_an_ordinary_member_leaving_changes_no_roles(self, make_member, leaver, private):
        keeper, colleague = make_member(role=MEMBER), make_member(role=MEMBER)
        self._add(private, colleague)
        ChannelMember.objects.filter(channel=private, user=leaver.member).update(role=ChannelMemberRole.MEMBER)
        self._add(private, keeper, role=ChannelMemberRole.ADMIN)
        self._leave(leaver)
        assert self._admins(private) == {keeper.id}

    def test_a_public_channel_is_not_handed_over(self, workspace, make_member, leaver):
        public = Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="general")
        self._add(public, leaver.member, role=ChannelMemberRole.ADMIN)
        self._add(public, make_member(role=MEMBER))
        self._leave(leaver)
        assert self._admins(public) == set()

    def test_nobody_left_is_fine(self, leaver, private):
        self._leave(leaver)
        assert not ChannelMember.objects.filter(channel=private).exists()

    def test_deactivating_the_account_hands_over_too(self, make_member, leaver, private):
        successor = make_member(role=MEMBER)
        self._add(private, successor)
        leaver.member.is_active = False
        leaver.member.save()
        assert self._admins(private) == {successor.id}
