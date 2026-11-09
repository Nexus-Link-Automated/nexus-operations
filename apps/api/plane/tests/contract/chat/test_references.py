# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A work item key in a message shows as a card only to someone who may see that work item."""

from unittest import mock

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from plane.chat.models import Message, MessageReference
from plane.db.models import Issue, Project, ProjectMember, State

ADMIN, MEMBER, GUEST = 20, 15, 5


@pytest.fixture
def project(workspace, create_user):
    return Project.objects.create(name="Employment", identifier="EMP", workspace=workspace, created_by=create_user)


@pytest.fixture
def issue(project, workspace, create_user):
    state = State.objects.create(
        name="In Review", group="started", color="#f59e0b", project=project, workspace=workspace
    )
    return Issue.objects.create(
        name="Fix the gateway",
        workspace=workspace,
        project=project,
        state=state,
        priority="high",
        created_by=create_user,
    )


@pytest.fixture
def key(issue):
    return f"EMP-{issue.sequence_id}"


@pytest.fixture
def in_project(project):
    def add(actor, role=MEMBER, is_active=True):
        ProjectMember.objects.create(
            project=project, workspace=project.workspace, member=actor.user, role=role, is_active=is_active
        )
        return actor

    return add


@pytest.fixture
def channel(make_channel, member, member2, guest, admin):
    return make_channel(members=[member.user, member2.user, guest.user, admin.user])


@pytest.fixture
def say(url):
    def say(actor, channel, html):
        response = actor.client.post(url(f"channels/{channel.id}/messages/"), {"body_html": html}, format="json")
        assert response.status_code == 201, response.content
        return response.data

    return say


@pytest.fixture
def seen_by(url):
    def seen_by(actor, channel, message):
        response = actor.client.get(url(f"channels/{channel.id}/messages/{message['id']}/"))
        assert response.status_code == 200, response.content
        return response.data

    return seen_by


@pytest.mark.contract
class TestWhoSeesTheCard:
    def test_a_project_member_sees_state_and_priority(self, member, channel, say, in_project, issue, key, project):
        in_project(member)
        message = say(member, channel, f"<p>see {key}</p>")
        assert message["references"] == [
            {
                "id": str(issue.id),
                "project": str(project.id),
                "key": key,
                "name": "Fix the gateway",
                "priority": "high",
                "state": {"name": "In Review", "group": "started", "color": "#f59e0b"},
            }
        ]

    def test_someone_without_access_sees_only_the_text(self, member, member2, channel, say, seen_by, in_project, key):
        in_project(member)
        message = say(member, channel, f"<p>see {key}</p>")
        seen = seen_by(member2, channel, message)
        assert seen["references"] == []
        assert key in seen["body_html"]
        assert "Fix the gateway" not in str(seen)

    def test_a_channel_listing_is_per_reader_too(self, member, member2, channel, say, url, in_project, key):
        in_project(member)
        say(member, channel, f"<p>{key}</p>")
        path = url(f"channels/{channel.id}/messages/")
        assert len(member.client.get(path).data["results"][0]["references"]) == 1
        assert member2.client.get(path).data["results"][0]["references"] == []

    def test_a_workspace_admin_outside_the_project_sees_only_the_text(
        self, member, admin, channel, say, seen_by, in_project, key
    ):
        in_project(member)
        assert seen_by(admin, channel, say(member, channel, f"<p>{key}</p>"))["references"] == []

    def test_a_deactivated_project_member_sees_only_the_text(
        self, member, member2, channel, say, seen_by, in_project, key
    ):
        in_project(member)
        in_project(member2, is_active=False)
        assert seen_by(member2, channel, say(member, channel, f"<p>{key}</p>"))["references"] == []

    def test_a_guest_sees_only_work_items_they_created(
        self, member, guest, channel, say, seen_by, in_project, issue, key
    ):
        in_project(member)
        in_project(guest, role=GUEST)
        message = say(member, channel, f"<p>{key}</p>")
        assert seen_by(guest, channel, message)["references"] == []
        Issue.objects.filter(pk=issue.pk).update(created_by=guest.user)
        assert len(seen_by(guest, channel, message)["references"]) == 1

    def test_a_guest_sees_everything_if_the_project_allows_it(
        self, member, guest, channel, say, seen_by, in_project, project, key
    ):
        in_project(member)
        in_project(guest, role=GUEST)
        Project.objects.filter(pk=project.pk).update(guest_view_all_features=True)
        assert len(seen_by(guest, channel, say(member, channel, f"<p>{key}</p>"))["references"]) == 1

    @pytest.mark.parametrize("change", ["archived", "draft", "soft_deleted"])
    def test_a_work_item_that_isnt_listable_shows_no_card(
        self, member, channel, say, seen_by, in_project, issue, key, change
    ):
        in_project(member)
        message = say(member, channel, f"<p>{key}</p>")
        assert len(seen_by(member, channel, message)["references"]) == 1
        if change == "archived":
            Issue.all_objects.filter(pk=issue.pk).update(archived_at="2026-01-01")
        elif change == "draft":
            Issue.all_objects.filter(pk=issue.pk).update(is_draft=True)
        else:
            Issue.all_objects.filter(pk=issue.pk).update(deleted_at="2026-01-01T00:00:00Z")
        assert seen_by(member, channel, message)["references"] == []

    def test_a_deleted_project_shows_no_card(self, member, channel, say, seen_by, in_project, project, key):
        in_project(member)
        message = say(member, channel, f"<p>{key}</p>")
        Project.all_objects.filter(pk=project.pk).update(deleted_at="2026-01-01T00:00:00Z")
        assert seen_by(member, channel, message)["references"] == []

    def test_a_work_item_in_another_workspace_isnt_a_reference(
        self, member, channel, say, other_workspace, in_project, create_user
    ):
        foreign = Project.objects.create(name="F", identifier="FOR", workspace=other_workspace, created_by=create_user)
        other = Issue.objects.create(name="secret", workspace=other_workspace, project=foreign)
        message = say(member, channel, f"<p>FOR-{other.sequence_id}</p>")
        assert message["references"] == []
        assert not MessageReference.objects.exists()


@pytest.mark.contract
class TestWhatCountsAsAReference:
    def test_a_key_that_doesnt_exist_is_just_text(self, member, channel, say, in_project, key):
        in_project(member)
        assert say(member, channel, "<p>EMP-99999</p>")["references"] == []

    @pytest.mark.parametrize(
        "html",
        [
            "<p>{key} and {key} again</p>",
            "<p>({key}), please</p>",
        ],
    )
    def test_it_is_one_reference_however_it_is_written(self, member, channel, say, in_project, key, html):
        in_project(member)
        assert len(say(member, channel, html.format(key=key))["references"]) == 1

    @pytest.mark.parametrize(
        "html",
        [
            "<p>emp-{n}</p>",
            "<p><code>EMP-{n}</code></p>",
            "<pre><code>EMP-{n}</code></pre>",
            '<p><a href="https://example.com">EMP-{n}</a></p>',
            "<p>MYEMP-{n}x</p>",
            "<p>EMP-{n}-draft</p>",
        ],
    )
    def test_things_that_are_not_references(self, member, channel, say, in_project, issue, html):
        in_project(member)
        assert say(member, channel, html.format(n=issue.sequence_id))["references"] == []

    def test_a_very_long_number_doesnt_break_the_message(self, member, channel, say):
        assert say(member, channel, "<p>EMP-99999999999999999999</p>")["references"] == []

    def test_only_the_first_ten_count(self, member, channel, say, in_project, workspace, project):
        in_project(member)
        issues = [Issue.objects.create(name=f"i{n}", workspace=workspace, project=project) for n in range(12)]
        body = " ".join(f"EMP-{item.sequence_id}" for item in issues)
        references = say(member, channel, f"<p>{body}</p>")["references"]
        assert [r["id"] for r in references] == [str(item.id) for item in issues[:10]]


@pytest.mark.contract
class TestKeepingReferencesCurrent:
    def edit(self, actor, channel, message, url, html):
        response = actor.client.patch(
            url(f"channels/{channel.id}/messages/{message['id']}/"), {"body_html": html}, format="json"
        )
        assert response.status_code == 200, response.content
        return response.data

    def test_an_edit_adds_and_drops_references(
        self, member, channel, say, url, in_project, workspace, project, key, issue
    ):
        in_project(member)
        other = Issue.objects.create(name="other", workspace=workspace, project=project)
        message = say(member, channel, f"<p>{key}</p>")
        edited = self.edit(member, channel, message, url, f"<p>EMP-{other.sequence_id}</p>")
        assert [r["id"] for r in edited["references"]] == [str(other.id)]
        assert MessageReference.objects.filter(message_id=message["id"]).count() == 1

    def test_an_edit_can_bring_a_reference_back(self, member, channel, say, url, in_project, key):
        in_project(member)
        message = say(member, channel, f"<p>{key}</p>")
        self.edit(member, channel, message, url, "<p>nothing here</p>")
        assert len(self.edit(member, channel, message, url, f"<p>{key}</p>")["references"]) == 1

    def test_removing_the_message_removes_its_cards(self, member, channel, say, seen_by, url, in_project, key):
        in_project(member)
        message = say(member, channel, f"<p>{key}</p>")
        assert member.client.delete(url(f"channels/{channel.id}/messages/{message['id']}/")).status_code == 204
        assert seen_by(member, channel, message)["references"] == []

    def test_a_failure_still_sends_the_message(self, member, channel, say, key):
        with mock.patch("plane.chat.references._sync", side_effect=RuntimeError("boom")):
            assert say(member, channel, f"<p>{key}</p>")["references"] == []

    def test_the_event_comes_after_the_references_exist(self, member, channel, url, in_project, key, published):
        in_project(member)
        order = []
        real = "plane.chat.views.message.sync_references"
        with mock.patch(real, side_effect=lambda message: order.append("sync")):
            with mock.patch(
                "plane.chat.views.message.publish_on_commit", side_effect=lambda *a, **k: order.append("publish")
            ):
                response = member.client.post(
                    url(f"channels/{channel.id}/messages/"), {"body_html": f"<p>{key}</p>"}, format="json"
                )
        assert response.status_code == 201
        assert order == ["sync", "publish"]

    def test_a_failed_query_while_syncing_keeps_the_edit(self, member, channel, say, url):
        message = say(member, channel, "<p>before</p>")

        def broken(*_args):
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1/0")

        with mock.patch("plane.chat.references._sync", broken):
            response = member.client.patch(
                url(f"channels/{channel.id}/messages/{message['id']}/"), {"body_html": "<p>kept</p>"}, format="json"
            )
        assert response.status_code == 200, response.content
        assert Message.objects.get(pk=message["id"]).body_stripped.strip() == "kept"

    def test_the_query_count_doesnt_grow_with_the_page(self, member, channel, say, url, in_project, key):
        in_project(member)
        for _ in range(3):
            say(member, channel, f"<p>{key}</p>")
        with CaptureQueriesContext(connection) as small:
            member.client.get(url(f"channels/{channel.id}/messages/"))
        for _ in range(12):
            say(member, channel, f"<p>{key}</p>")
        with CaptureQueriesContext(connection) as large:
            member.client.get(url(f"channels/{channel.id}/messages/"))
        assert len(large) == len(small)
