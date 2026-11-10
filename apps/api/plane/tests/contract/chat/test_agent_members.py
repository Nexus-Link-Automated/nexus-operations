# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""agents/ and agents/<agent_id>/: agents from the registry as members of public and private channels."""

from uuid import uuid4

import pytest
from crum import impersonate
from django.core.exceptions import ValidationError

from plane.chat.models import Channel, ChannelAgent, ChannelKind, ChannelMember, ChannelMemberRole
from plane.license.models import AgentDefinition


@pytest.fixture
def make_agent(db):
    def make(name="Reviewer", enabled=True, default="ask_writes", maximum="ask_writes", slug=None):
        return AgentDefinition.objects.create(
            name=name,
            slug=slug or f"agent-{uuid4().hex[:8]}",
            adapter="claude",
            default_permission_level=default,
            max_permission_level=maximum,
            is_enabled=enabled,
        )

    return make


@pytest.fixture
def agent(make_agent):
    return make_agent()


@pytest.fixture
def add(url):
    """add(actor, channel, agent) -> the response to adding it."""

    def add(actor, channel, agent_or_id, **body):
        agent_id = getattr(agent_or_id, "pk", agent_or_id)
        return actor.client.post(
            url(f"channels/{channel.id}/agents/"), {"agent_id": str(agent_id), **body}, format="json"
        )

    return add


@pytest.fixture
def remove(url):
    def remove(actor, channel, agent):
        return actor.client.delete(url(f"channels/{channel.id}/agents/{agent.pk}/"))

    return remove


@pytest.fixture
def listed(url):
    """The agents `actor` is shown in `channel`, by slug."""

    def listed(actor, channel):
        response = actor.client.get(url(f"channels/{channel.id}/agents/"))
        assert response.status_code == 200, response.data
        return {row["slug"]: row for row in response.data}

    return listed


def seat(channel, agent, added_by=None, level="ask_writes"):
    row = ChannelAgent(channel=channel, agent=agent, permission_level=level)
    row.save(created_by_id=getattr(added_by, "pk", None))
    return row


@pytest.mark.contract
@pytest.mark.django_db
class TestWhoCanAdd:
    def test_a_channel_admin_adds_an_agent(self, member, make_channel, agent, add, listed):
        channel = make_channel(admins=[member.user])
        response = add(member, channel, agent)
        assert response.status_code == 201, response.data
        assert response.data == {
            "id": str(ChannelAgent.objects.get().id),
            "channel": str(channel.id),
            "agent": str(agent.id),
            "slug": agent.slug,
            "name": "Reviewer",
            "description": "",
            "adapter": "claude",
            "permission_level": "ask_writes",
            "is_available": True,
            "added_by": str(member.user.id),
            "added_at": response.data["added_at"],
        }
        assert list(listed(member, channel)) == [agent.slug]
        # People's membership is untouched: the agent isn't a person.
        assert ChannelMember.objects.filter(channel=channel).count() == 1

    def test_a_channel_admin_adds_one_to_their_private_channel(self, member, make_channel, agent, add):
        channel = make_channel(ChannelKind.PRIVATE, admins=[member.user])
        assert add(member, channel, agent).status_code == 201

    def test_a_workspace_admin_adds_one_without_being_in_the_channel(self, admin, make_channel, agent, add):
        assert add(admin, make_channel(), agent).status_code == 201

    def test_a_member_who_is_not_a_channel_admin_is_refused(self, member, make_channel, agent, add):
        channel = make_channel(members=[member.user])
        assert add(member, channel, agent).status_code == 403
        assert not ChannelAgent.objects.exists()

    def test_a_guest_is_refused_even_as_channel_admin(self, guest, make_channel, agent, add):
        assert add(guest, make_channel(admins=[guest.user]), agent).status_code == 403
        assert add(guest, make_channel(members=[guest.user]), agent).status_code == 403
        assert not ChannelAgent.objects.exists()

    def test_someone_who_cannot_see_the_channel_gets_404(self, admin, member, member2, make_channel, agent, add):
        private = make_channel(ChannelKind.PRIVATE, admins=[member2.user])
        assert add(member, private, agent).status_code == 404
        # Workspace admins don't see private channels they aren't in either.
        assert add(admin, private, agent).status_code == 404

    def test_an_outsider_is_refused(self, outsider, make_channel, agent, add):
        assert add(outsider, make_channel(), agent).status_code == 403

    def test_another_workspaces_channel_is_not_found(self, admin, foreign_channel, agent, add):
        assert add(admin, foreign_channel, agent).status_code == 404

    def test_adding_it_again_changes_nothing(self, member, make_channel, agent, add):
        channel = make_channel(admins=[member.user])
        first = add(member, channel, agent)
        again = add(member, channel, agent, permission_level="ask_all")
        assert again.status_code == 200
        assert again.data["id"] == first.data["id"] and again.data["permission_level"] == "ask_writes"
        assert ChannelAgent.objects.count() == 1

    def test_an_archived_channel_is_read_only(self, admin, make_channel, agent, add):
        channel = make_channel()
        Channel.objects.filter(pk=channel.pk).update(archived_at=channel.created_at)
        assert add(admin, channel, agent).status_code == 409


@pytest.mark.contract
@pytest.mark.django_db
class TestWhichAgents:
    def test_a_disabled_agent_is_refused(self, admin, make_channel, make_agent, add):
        response = add(admin, make_channel(), make_agent(enabled=False))
        assert response.status_code == 400
        assert response.data["error"] == "This agent isn't available in this workspace."

    def test_an_unknown_agent_is_refused_the_same_way(self, admin, make_channel, add):
        response = add(admin, make_channel(), uuid4())
        assert response.status_code == 400
        assert response.data["error"] == "This agent isn't available in this workspace."

    def test_a_malformed_body_is_refused(self, admin, make_channel, url):
        channel = make_channel()
        path = url(f"channels/{channel.id}/agents/")
        assert admin.client.post(path, {}, format="json").status_code == 400
        assert admin.client.post(path, {"agent_id": "nope"}, format="json").status_code == 400

    def test_the_registry_default_level_applies(self, admin, make_channel, make_agent, add):
        agent = make_agent(default="ask_all", maximum="yolo")
        assert add(admin, make_channel(), agent).data["permission_level"] == "ask_all"

    def test_any_level_up_to_the_maximum(self, admin, make_channel, make_agent, add):
        agent = make_agent(default="ask_all", maximum="ask_writes")
        assert add(admin, make_channel(), agent, permission_level="ask_writes").data["permission_level"] == "ask_writes"

    def test_a_level_above_the_maximum_is_refused(self, admin, make_channel, make_agent, add):
        agent = make_agent(default="ask_all", maximum="ask_writes")
        response = add(admin, make_channel(), agent, permission_level="yolo")
        assert response.status_code == 400
        assert add(admin, make_channel(), agent, permission_level="root").status_code == 400
        assert not ChannelAgent.objects.exists()

    def test_a_channel_caps_the_level_at_asking_for_writes(self, admin, make_channel, make_agent, add, listed):
        agent = make_agent(default="yolo", maximum="yolo")
        assert add(admin, make_channel(), agent).data["permission_level"] == "ask_writes"
        assert add(admin, make_channel(), agent, permission_level="yolo").status_code == 400
        # A seat stored above the cap (added before it, say) works at the cap.
        channel = make_channel()
        seat(channel, agent, level="yolo")
        assert listed(admin, channel)[agent.slug]["permission_level"] == "ask_writes"

    def test_a_lowered_maximum_lowers_the_level_shown(self, admin, make_channel, make_agent, add, listed):
        agent = make_agent(default="yolo", maximum="yolo")
        channel = make_channel()
        add(admin, channel, agent)
        AgentDefinition.objects.filter(pk=agent.pk).update(max_permission_level="ask_all")
        assert listed(admin, channel)[agent.slug]["permission_level"] == "ask_all"


@pytest.mark.contract
@pytest.mark.django_db
class TestNoAgentsInDirectMessages:
    def test_dms_and_group_dms_are_refused(self, workspace, admin, member, member2, agent, add, remove):
        dm = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)[0]
        group = Channel.objects.get_or_create_group_dm(workspace, [admin.user, member.user, member2.user])[0]
        assert add(member, dm, agent).status_code == 409
        assert add(admin, group, agent).status_code == 409
        assert remove(admin, group, agent).status_code == 409
        assert not ChannelAgent.objects.exists()

    def test_the_model_refuses_too(self, workspace, member, member2, agent):
        dm = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)[0]
        with pytest.raises(ValidationError):
            ChannelAgent.objects.create(channel=dm, agent=agent, permission_level="ask_all")


@pytest.mark.contract
@pytest.mark.django_db
class TestWhoCanRemove:
    def test_a_channel_admin_removes_an_agent(self, member, make_channel, agent, remove, listed):
        channel = make_channel(admins=[member.user])
        seat(channel, agent)
        assert remove(member, channel, agent).status_code == 204
        assert listed(member, channel) == {}
        assert remove(member, channel, agent).status_code == 404

    def test_a_workspace_admin_removes_one(self, admin, make_channel, agent, remove):
        channel = make_channel()
        seat(channel, agent)
        assert remove(admin, channel, agent).status_code == 204

    def test_who_added_it_gets_no_say_of_their_own(self, member, make_channel, agent, add, remove):
        """Removing an agent follows the rule for removing anyone: a channel admin or a workspace admin."""
        channel = make_channel(admins=[member.user])
        add(member, channel, agent)
        ChannelMember.objects.filter(channel=channel, user=member.user).update(role=ChannelMemberRole.MEMBER)
        assert remove(member, channel, agent).status_code == 403
        assert ChannelAgent.objects.filter(channel=channel).exists()

    def test_members_guests_and_outsiders_are_refused(self, member, guest, outsider, make_channel, agent, remove):
        channel = make_channel(members=[member.user, guest.user])
        seat(channel, agent)
        assert remove(member, channel, agent).status_code == 403
        assert remove(guest, channel, agent).status_code == 403
        assert remove(outsider, channel, agent).status_code == 403
        assert ChannelAgent.objects.filter(channel=channel).exists()

    def test_someone_who_cannot_see_the_channel_gets_404(self, member, member2, make_channel, agent, remove):
        private = make_channel(ChannelKind.PRIVATE, admins=[member2.user])
        seat(private, agent)
        assert remove(member, private, agent).status_code == 404

    def test_an_archived_channel_is_read_only(self, admin, make_channel, agent, remove):
        channel = make_channel()
        seat(channel, agent)
        Channel.objects.filter(pk=channel.pk).update(archived_at=channel.created_at)
        assert remove(admin, channel, agent).status_code == 409

    def test_an_unavailable_agent_can_still_be_removed(self, admin, make_channel, make_agent, remove):
        agent = make_agent(enabled=False)
        channel = make_channel()
        seat(channel, agent)
        assert remove(admin, channel, agent).status_code == 204

    def test_removed_then_added_again(self, admin, make_channel, agent, add, remove):
        channel = make_channel()
        add(admin, channel, agent)
        remove(admin, channel, agent)
        assert add(admin, channel, agent).status_code == 201


@pytest.mark.contract
@pytest.mark.django_db
class TestList:
    def test_anyone_who_can_see_the_channel(self, admin, member, guest, make_channel, agent, listed):
        channel = make_channel(members=[guest.user])
        seat(channel, agent, added_by=admin.user)
        for actor in (admin, member, guest):
            assert listed(actor, channel)[agent.slug]["added_by"] == str(admin.user.id)

    def test_nothing_of_the_registry_configuration(self, admin, make_channel, agent, url):
        channel = make_channel()
        agent.set_env({"ANTHROPIC_API_KEY": "sk-secret"})
        agent.save()
        seat(channel, agent)
        response = admin.client.get(url(f"channels/{channel.id}/agents/"))
        assert "sk-secret" not in response.content.decode() and "env" not in response.data[0]

    def test_refused_to_those_who_cannot_see_it(self, member, member2, outsider, make_channel, agent, url):
        private = make_channel(ChannelKind.PRIVATE, admins=[member2.user])
        seat(private, agent)
        assert member.client.get(url(f"channels/{private.id}/agents/")).status_code == 404
        assert outsider.client.get(url(f"channels/{private.id}/agents/")).status_code == 403

    def test_a_dm_has_none(self, workspace, member, member2, url):
        dm = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)[0]
        assert member.client.get(url(f"channels/{dm.id}/agents/")).data == []


@pytest.mark.contract
@pytest.mark.django_db
class TestRegistryLifecycle:
    def test_a_disabled_agent_is_listed_as_unavailable(self, member, make_channel, agent, listed):
        channel = make_channel(members=[member.user])
        seat(channel, agent)
        agent.is_enabled = False
        agent.save()
        assert listed(member, channel)[agent.slug]["is_available"] is False
        agent.is_enabled = True
        agent.save()
        assert listed(member, channel)[agent.slug]["is_available"] is True

    def test_an_agent_deleted_from_the_registry_leaves_every_channel(self, member, make_channel, agent, listed):
        channels = [make_channel(members=[member.user]) for _ in range(2)]
        for channel in channels:
            seat(channel, agent)
        agent.delete(soft=False)
        assert not ChannelAgent.all_objects.exists()
        assert all(listed(member, channel) == {} for channel in channels)

    def test_a_soft_deleted_agent_is_not_listed(self, member, make_channel, agent, listed):
        channel = make_channel(members=[member.user])
        seat(channel, agent)
        AgentDefinition.objects.filter(pk=agent.pk).update(deleted_at=agent.created_at)
        assert listed(member, channel) == {}

    def test_a_deleted_channels_agents_are_out_of_reach(self, admin, make_channel, agent, add, url):
        channel = make_channel()
        add(admin, channel, agent)
        Channel.objects.filter(pk=channel.pk).update(deleted_at=channel.created_at)
        assert admin.client.get(url(f"channels/{channel.id}/agents/")).status_code == 404
        assert add(admin, channel, agent).status_code == 404


@pytest.mark.contract
@pytest.mark.django_db
class TestMe:
    def test_who_may_add_agents(self, admin, member, guest, url):
        assert admin.client.get(url("me/")).data["can_add_agents"] is True
        assert member.client.get(url("me/")).data["can_add_agents"] is True
        assert guest.client.get(url("me/")).data["can_add_agents"] is False


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
class TestEvents:
    """The usual `member.*` events, naming the agent (`agent_id`) instead of a person, published once committed."""

    @staticmethod
    def expected(type_, channel, agent, actor=None):
        event = {"type": type_, "workspace_id": str(channel.workspace_id), "channel_id": str(channel.id)}
        event["agent_id"] = str(agent.id)
        if actor is not None:
            event["actor_id"] = str(actor.user.id)
        return event

    def test_adding_and_removing(self, admin, make_channel, agent, add, remove, published):
        channel = make_channel()
        add(admin, channel, agent)
        add(admin, channel, agent)  # Already in: nothing changes, nothing is said.
        remove(admin, channel, agent)
        assert published.events == [
            self.expected("member.added", channel, agent, admin),
            self.expected("member.removed", channel, agent, admin),
        ]
        assert all("user_id" not in event for event in published.events)

    def test_refusals_say_nothing(self, member, make_channel, make_agent, add, remove, published):
        channel = make_channel(members=[member.user])
        add(member, channel, make_agent())
        add(member, channel, make_agent(enabled=False))
        remove(member, channel, make_agent())
        assert published.events == []

    def test_disabling_enabling_and_deleting_in_the_registry(self, make_channel, agent, published):
        channels = [make_channel(), make_channel()]
        for channel in channels:
            seat(channel, agent)
        gone = make_channel()
        seat(gone, agent)
        Channel.objects.filter(pk=gone.pk).update(deleted_at=gone.created_at)

        # Worked out first: deleting the agent clears its ID.
        removed = [self.expected("member.removed", channel, agent) for channel in channels]
        added = [self.expected("member.added", channel, agent) for channel in channels]

        agent.is_enabled = False
        agent.save()
        agent.save()  # Still disabled: nothing more.
        agent.is_enabled = True
        agent.save()
        agent.delete(soft=False)

        events = published.events
        assert sorted(events[0:2], key=str) == sorted(removed, key=str)
        assert sorted(events[2:4], key=str) == sorted(added, key=str)
        assert sorted(events[4:], key=str) == sorted(removed, key=str)

    def test_the_instance_admin_who_changed_the_registry_is_not_named(
        self, make_channel, agent, published, create_user
    ):
        # They needn't be in the workspace, so their ID has no place in its channels' events.
        seat(make_channel(), agent)
        with impersonate(create_user):
            agent.is_enabled = False
            agent.save()
            agent.is_enabled = True
            agent.save()
            agent.delete(soft=False)
        assert len(published.events) == 3
        assert all("actor_id" not in event for event in published.events)

    def test_deleting_a_disabled_agent_says_nothing_more(self, make_channel, make_agent, published):
        agent = make_agent(enabled=False)
        seat(make_channel(), agent)
        agent.delete(soft=False)
        assert published.events == []

    def test_a_renamed_agent_says_nothing(self, make_channel, agent, published):
        seat(make_channel(), agent)
        agent.name = "Renamed"
        agent.save()
        assert published.events == []
