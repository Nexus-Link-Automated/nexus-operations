# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Membership changes that bypass the chat views still reach the gateway, and only when something really changed."""

from unittest import mock

import pytest
from django.db import transaction

from plane.chat.models import Channel, ChannelKind, ChannelMember, ChannelMemberRole
from plane.db.models import WorkspaceMember
from plane.settings.redis import redis_instance
from plane.tests.factories import WorkspaceFactory

GUEST, MEMBER = 5, 15


def _sorted(events):
    return sorted(events, key=lambda event: (event["type"], event["workspace_id"], event.get("channel_id", "")))


@pytest.fixture
def leaver(workspace, make_member):
    return WorkspaceMember.objects.get(workspace=workspace, member=make_member(role=MEMBER))


@pytest.fixture
def make_channel(workspace):
    def make(kind=ChannelKind.PUBLIC, name=None, in_workspace=None, admins=(), members=()):
        channel = Channel.objects.create(
            workspace=in_workspace or workspace,
            kind=kind,
            name=name or f"c-{Channel.objects.count()}",
        )
        for user in admins:
            ChannelMember.objects.create(channel=channel, user=user, role=ChannelMemberRole.ADMIN)
        for user in members:
            ChannelMember.objects.create(channel=channel, user=user)
        return channel

    return make


@pytest.fixture
def removed(workspace):
    def build(channel, user):
        return {
            "type": "member.removed",
            "workspace_id": str(channel.workspace_id),
            "channel_id": str(channel.id),
            "user_id": str(user.id),
        }

    return build


@pytest.fixture
def revoked(workspace):
    def build(user, in_workspace=None):
        return {
            "type": "access.revoked",
            "workspace_id": str((in_workspace or workspace).id),
            "user_id": str(user.id),
        }

    return build


def _leave(membership):
    membership.is_active = False
    membership.save()


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestLeavingTheWorkspace:
    def test_every_channel_hears_it_and_then_access_ends(
        self, workspace, leaver, make_channel, make_member, published, removed, revoked
    ):
        user = leaver.member
        public = make_channel(members=[user])
        private = make_channel(ChannelKind.PRIVATE, members=[user], admins=[make_member()])
        dm, _ = Channel.objects.get_or_create_dm(workspace, user, make_member())
        published.clear()

        _leave(leaver)

        events = published.events
        assert _sorted(events[:-1]) == _sorted([removed(public, user), removed(private, user)])
        assert events[-1] == revoked(user)
        assert ChannelMember.objects.filter(channel=dm, user=user).exists()

    def test_being_removed_is_the_same(self, leaver, make_channel, published, removed, revoked):
        public = make_channel(members=[leaver.member])

        leaver.delete()

        assert published.events == [removed(public, leaver.member), revoked(leaver.member)]

    def test_someone_in_no_channels_still_loses_access(self, leaver, published, revoked):
        _leave(leaver)
        assert published.events == [revoked(leaver.member)]

    def test_saving_someone_already_gone_is_silent(self, leaver, make_channel, published):
        make_channel(members=[leaver.member])
        _leave(leaver)
        published.clear()

        leaver.save()
        leaver.delete()

        assert published.events == []

    def test_a_new_row_that_starts_inactive_is_silent(self, workspace, make_member, published):
        WorkspaceMember.objects.create(workspace=WorkspaceFactory(), member=make_member(), role=MEMBER, is_active=False)
        assert published.events == []

    def test_other_saves_are_silent(self, leaver, make_channel, published):
        make_channel(members=[leaver.member])

        leaver.view_props = {"x": 1}
        leaver.save(update_fields=["view_props"])
        leaver.save()
        leaver.role = GUEST
        leaver.save()

        assert published.events == []
        assert ChannelMember.objects.filter(user=leaver.member).exists()

    def test_it_all_goes_over_one_connection(self, leaver, make_channel, make_member):
        """A Redis that has stopped answering costs one timeout, however many channels are involved."""
        for _ in range(3):
            make_channel(ChannelKind.PRIVATE, admins=[leaver.member], members=[make_member(role=MEMBER)])
        make_channel(members=[leaver.member])

        with mock.patch("plane.chat.events.redis_instance", wraps=redis_instance) as make_client:
            _leave(leaver)

        assert make_client.call_count == 1

    def test_a_rolled_back_departure_publishes_nothing(self, leaver, make_channel, published):
        make_channel(members=[leaver.member])

        with pytest.raises(RuntimeError), transaction.atomic():
            _leave(leaver)
            raise RuntimeError("rolled back")

        assert published.events == []
        assert ChannelMember.objects.filter(user=leaver.member).exists()

    def test_it_waits_for_the_callers_commit(self, leaver, make_channel, published, removed, revoked):
        public = make_channel(members=[leaver.member])

        with transaction.atomic():
            _leave(leaver)
            assert published.events == []

        assert published.events == [removed(public, leaver.member), revoked(leaver.member)]


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestPrivateChannelHandover:
    def test_the_successor_is_announced_before_the_leaver_goes(
        self, leaver, make_channel, make_member, published, removed, revoked
    ):
        heir = make_member(role=MEMBER)
        private = make_channel(ChannelKind.PRIVATE, admins=[leaver.member], members=[heir])

        _leave(leaver)

        assert published.events == [
            {
                "type": "member.updated",
                "workspace_id": str(private.workspace_id),
                "channel_id": str(private.id),
                "user_id": str(heir.id),
            },
            removed(private, leaver.member),
            revoked(leaver.member),
        ]
        assert ChannelMember.objects.get(channel=private, user=heir).role == ChannelMemberRole.ADMIN

    def test_nobody_new_is_announced_when_another_admin_remains(
        self, leaver, make_channel, make_member, published, removed, revoked
    ):
        private = make_channel(ChannelKind.PRIVATE, admins=[leaver.member, make_member(role=MEMBER)])

        _leave(leaver)

        assert published.events == [removed(private, leaver.member), revoked(leaver.member)]

    def test_nobody_to_hand_over_to(self, leaver, make_channel, published, removed, revoked):
        private = make_channel(ChannelKind.PRIVATE, admins=[leaver.member])

        _leave(leaver)

        assert published.events == [removed(private, leaver.member), revoked(leaver.member)]


@pytest.mark.unit
@pytest.mark.django_db(transaction=True)
class TestDeactivatingAnAccount:
    def _deactivate(self, user):
        """As `UserEndpoint.deactivate` does: the memberships first (`bulk_update`, no signal), then the account."""
        WorkspaceMember.objects.filter(member=user).update(is_active=False)
        user.is_active = False
        user.save()

    def test_every_workspace_hears_it(self, workspace, leaver, make_channel, published, removed, revoked):
        user = leaver.member
        elsewhere = WorkspaceFactory()
        WorkspaceMember.objects.create(workspace=elsewhere, member=user, role=MEMBER)
        here = make_channel(members=[user])
        there = make_channel(in_workspace=elsewhere, name="there", members=[user])

        self._deactivate(user)

        assert _sorted(published.events) == _sorted(
            [removed(here, user), removed(there, user), revoked(user), revoked(user, in_workspace=elsewhere)]
        )

    def test_a_handover_is_announced(self, leaver, make_channel, make_member, published):
        heir = make_member(role=MEMBER)
        private = make_channel(ChannelKind.PRIVATE, admins=[leaver.member], members=[heir])

        self._deactivate(leaver.member)

        assert [
            (event["type"], event.get("user_id"))
            for event in published.events
            if event.get("channel_id") == str(private.id)
        ] == [("member.updated", str(heir.id)), ("member.removed", str(leaver.member.id))]

    def test_it_all_goes_over_one_connection(self, leaver, make_channel, make_member):
        for _ in range(3):
            make_channel(ChannelKind.PRIVATE, admins=[leaver.member], members=[make_member(role=MEMBER)])

        with mock.patch("plane.chat.events.redis_instance", wraps=redis_instance) as make_client:
            self._deactivate(leaver.member)

        assert make_client.call_count == 1

    def test_saving_a_deactivated_account_again_is_silent(self, leaver, make_channel, published):
        make_channel(members=[leaver.member])
        self._deactivate(leaver.member)
        published.clear()

        leaver.member.first_name = "Still gone"
        leaver.member.save()

        assert published.events == []

    def test_other_saves_of_an_active_account_are_silent(self, leaver, make_channel, published):
        make_channel(members=[leaver.member])

        leaver.member.first_name = "Renamed"
        leaver.member.save()

        assert published.events == []
