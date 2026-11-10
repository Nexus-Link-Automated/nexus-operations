# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A work item created from a message is linked both ways, and the channel is told."""

import pytest

from plane.chat.events import EventType
from plane.chat.models import ChannelKind, Message, MessageReference
from plane.db.models import Issue, IssueLink, Project, ProjectMember

MEMBER, GUEST = 15, 5
WEB_URL = "https://ops.example.com"


@pytest.fixture(autouse=True)
def web_url(settings):
    settings.WEB_URL = WEB_URL
    settings.APP_BASE_URL = WEB_URL


@pytest.fixture
def project(workspace, create_user):
    return Project.objects.create(name="Employment", identifier="EMP", workspace=workspace, created_by=create_user)


@pytest.fixture
def issue(project, workspace, create_user):
    return Issue.objects.create(name="Login is broken", workspace=workspace, project=project, created_by=create_user)


@pytest.fixture
def in_project(project):
    def add(actor, role=MEMBER):
        ProjectMember.objects.create(project=project, workspace=project.workspace, member=actor.user, role=role)
        return actor

    return add


@pytest.fixture
def channel(make_channel, member, member2):
    return make_channel(name="development", members=[member.user, member2.user])


@pytest.fixture
def report(channel, member2, send):
    return send(channel, member2.user, "login is broken on staging")


@pytest.fixture
def link(url):
    def link(actor, channel, message, issue_id):
        return actor.client.post(
            url(f"channels/{channel.id}/messages/{message.id}/work-items/"), {"issue_id": str(issue_id)}, format="json"
        )

    return link


@pytest.mark.contract
class TestLinking:
    def test_links_both_ways_and_says_so_in_the_channel(
        self, member, channel, report, link, in_project, issue, workspace
    ):
        in_project(member)
        response = link(member, channel, report, issue.id)
        assert response.status_code == 201, response.content

        # Message → work item: a card on the original message.
        assert [r["key"] for r in response.data["message"]["references"]] == [f"EMP-{issue.sequence_id}"]

        # Work item → message: a link on the work item, back to this message.
        issue_link = IssueLink.objects.get(issue=issue)
        assert issue_link.url == f"{WEB_URL}/{workspace.slug}/messages/{channel.id}?message={report.id}"
        assert issue_link.title == "Message in #development"

        # A note in the message's thread from whoever clicked, with the card too; the channel has the card already.
        reply = response.data["reply"]
        assert reply["sender"] == member.user.id
        assert reply["parent"] == report.id
        assert response.data["message"]["reply_count"] == 1
        assert f"EMP-{issue.sequence_id}" in reply["body_html"]
        assert [r["id"] for r in reply["references"]] == [str(issue.id)]

    def test_linking_again_changes_nothing(self, member, channel, report, link, in_project, issue):
        in_project(member)
        assert link(member, channel, report, issue.id).status_code == 201
        again = link(member, channel, report, issue.id)
        assert again.status_code == 200
        assert again.data["reply"] is None
        assert MessageReference.objects.filter(message=report, issue=issue).count() == 1
        assert IssueLink.objects.filter(issue=issue).count() == 1
        assert Message.objects.filter(channel=channel).count() == 2

    def test_a_private_channels_name_stays_off_the_work_item(self, member, make_channel, send, link, in_project, issue):
        in_project(member)
        secret = make_channel(kind=ChannelKind.PRIVATE, name="layoffs", members=[member.user])
        message = send(secret, member.user, "bug")
        assert link(member, secret, message, issue.id).status_code == 201
        assert IssueLink.objects.get(issue=issue).title == "Message in Nexus Messages"

    def test_a_thread_reply_links_to_itself_in_its_thread(self, member, channel, report, send, link, in_project, issue):
        in_project(member)
        reply = send(channel, member.user, "still broken", parent=report)
        response = link(member, channel, reply, issue.id)
        assert response.status_code == 201
        assert IssueLink.objects.get(issue=issue).url.endswith(f"?message={report.id}&reply={reply.id}")
        # The note joins the same thread: threads are one level deep.
        assert response.data["reply"]["parent"] == report.id

    @pytest.mark.django_db(transaction=True)
    def test_the_channel_hears_about_it_once(self, member, channel, report, link, in_project, issue, published):
        in_project(member)
        assert link(member, channel, report, issue.id).status_code == 201
        assert [event["type"] for event in published.events] == [EventType.MESSAGE_UPDATED, EventType.MESSAGE_CREATED]
        assert published.events[1]["parent_id"] == str(report.id)
        assert link(member, channel, report, issue.id).status_code == 200
        assert len(published.events) == 2

    def test_the_link_survives_editing_the_message(self, member2, channel, report, link, url, in_project, issue):
        in_project(member2)
        assert link(member2, channel, report, issue.id).status_code == 201
        edited = member2.client.patch(
            url(f"channels/{channel.id}/messages/{report.id}/"), {"body_html": "<p>rewritten</p>"}, format="json"
        )
        assert edited.status_code == 200
        assert [r["id"] for r in edited.data["references"]] == [str(issue.id)]


@pytest.mark.contract
class TestWhoCanLink:
    def test_someone_who_cant_see_the_work_item_gets_404(self, member, channel, report, link, issue):
        assert link(member, channel, report, issue.id).status_code == 404
        assert not MessageReference.objects.exists()
        assert not IssueLink.objects.exists()

    def test_a_guest_cant_link_what_they_cant_see(self, guest, make_channel, send, link, in_project, issue):
        in_project(guest, role=GUEST)
        channel = make_channel(members=[guest.user])
        assert link(guest, channel, send(channel, guest.user), issue.id).status_code == 404

    def test_a_work_item_from_another_workspace_is_404(
        self, member, channel, report, link, other_workspace, create_user
    ):
        foreign = Project.objects.create(name="F", identifier="FOR", workspace=other_workspace, created_by=create_user)
        ProjectMember.objects.create(project=foreign, workspace=other_workspace, member=member.user, role=MEMBER)
        other = Issue.objects.create(name="secret", workspace=other_workspace, project=foreign)
        assert link(member, channel, report, other.id).status_code == 404

    def test_a_public_channel_you_havent_joined_is_403(self, admin, channel, report, link, in_project, issue):
        in_project(admin)
        assert link(admin, channel, report, issue.id).status_code == 403

    def test_a_private_channel_youre_not_in_is_404(self, member, member2, make_channel, send, link, in_project, issue):
        in_project(member)
        secret = make_channel(kind=ChannelKind.PRIVATE, members=[member2.user])
        assert link(member, secret, send(secret, member2.user), issue.id).status_code == 404

    def test_a_removed_message_is_404(self, member, channel, report, link, in_project, issue):
        in_project(member)
        report.remove()
        assert link(member, channel, report, issue.id).status_code == 404

    def test_an_archived_channel_refuses(self, member, channel, report, link, in_project, issue):
        in_project(member)
        channel.archived_at = "2026-01-01T00:00:00Z"
        channel.save(update_fields=["archived_at"])
        assert link(member, channel, report, issue.id).status_code in (403, 409)

    def test_a_malformed_id_is_400(self, member, channel, report, url):
        response = member.client.post(
            url(f"channels/{channel.id}/messages/{report.id}/work-items/"), {"issue_id": "nope"}, format="json"
        )
        assert response.status_code == 400
