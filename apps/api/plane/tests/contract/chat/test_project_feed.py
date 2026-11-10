# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Project channels: who may link a channel to a project, and the automatic posts about its work items' states.

State changes go through Plane's real `issue_activity` task and real Redis. Only scheduling the posting
run on the broker is replaced: `scheduled` records it, and `run_feed` runs it as the worker would.
"""

import json
from unittest import mock

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.bgtasks.issue_activities_task import issue_activity
from plane.chat import project_feed
from plane.chat.models import Channel, ChannelKind, Message, MessageReference, MessageSystemEvent
from plane.db.models import Issue, IssueActivity, Notification, Project, ProjectMember, State
from plane.settings.redis import redis_instance

ADMIN, MEMBER, GUEST = 20, 15, 5


@pytest.fixture
def project(workspace, create_user):
    return Project.objects.create(name="Gateway", identifier="EMP", workspace=workspace, created_by=create_user)


@pytest.fixture
def states(project, workspace):
    def state(name, group):
        return State.objects.create(name=name, group=group, color="#000000", project=project, workspace=workspace)

    return {
        "todo": state("Todo", "unstarted"),
        "progress": state("In Progress", "started"),
        "review": state("In Review", "started"),
        "done": state("Done", "completed"),
    }


@pytest.fixture
def make_issue(project, workspace, create_user, states):
    def make(name="Fix the gateway", state="todo", **fields):
        return Issue.objects.create(
            name=name, workspace=workspace, project=project, state=states[state], created_by=create_user, **fields
        )

    return make


@pytest.fixture
def in_project(project):
    def add(actor, role=MEMBER):
        ProjectMember.objects.create(
            project=project, workspace=project.workspace, member=actor.user, role=role, is_active=True
        )
        return actor

    return add


@pytest.fixture
def scheduled():
    """The posting runs `queue_state_changes` scheduled, as `(project_id, countdown)`."""
    calls = []
    with mock.patch.object(
        project_feed.post_project_feed,
        "apply_async",
        side_effect=lambda args, countdown: calls.append((args[0], countdown)),
    ):
        yield calls


@pytest.fixture(autouse=True)
def clean_redis(project):
    yield
    redis_instance().delete(project_feed._pending_key(project.id), project_feed._scheduled_key(project.id))


@pytest.fixture
def change(states, create_user, django_capture_on_commit_callbacks):
    """Run Plane's activity task for an update to `issue`, as the app's work item endpoints do, and commit it."""

    def run(issue, requested, current=None, project_id=None):
        with django_capture_on_commit_callbacks(execute=True):
            issue_activity(
                type="issue.activity.updated",
                requested_data=json.dumps(requested),
                current_instance=json.dumps(current or {}),
                issue_id=str(issue.id),
                actor_id=str(create_user.id),
                project_id=str(project_id or issue.project_id),
                epoch=int(timezone.now().timestamp()),
                notification=False,
            )

    return run


@pytest.fixture
def move(change, states):
    def run(issue, to, frm=None):
        old = states[frm].id if frm else issue.state_id
        issue.state = states[to]
        issue.save()
        change(issue, {"state_id": str(states[to].id)}, {"state_id": str(old)})

    return run


@pytest.fixture
def run_feed(project, django_capture_on_commit_callbacks):
    def run():
        with django_capture_on_commit_callbacks(execute=True):
            project_feed.post_project_feed(str(project.id))

    return run


def _feed(channel):
    return list(Message.objects.filter(channel=channel, system_event=MessageSystemEvent.WORK_ITEM_STATE))


def _key(issue):
    return f"EMP-{issue.sequence_id}"


def _shown(message):
    """The post's body as a reader who may see all its work items reads it."""
    keys = {str(reference.issue_id): _key(reference.issue) for reference in message.references.select_related("issue")}
    return project_feed.body_for_reader(message, keys)


@pytest.mark.contract
@pytest.mark.django_db
class TestLinking:
    def test_a_project_member_or_admin_can_link_on_create(self, member, in_project, project, url):
        in_project(member, MEMBER)
        res = member.client.post(url("channels/"), {"name": "gateway", "project": str(project.id)}, format="json")
        assert res.status_code == 201 and res.data["project"] == project.id

    def test_project_guests_and_archived_projects_are_refused(self, member, member2, in_project, project, url):
        in_project(member, GUEST)
        res = member.client.post(url("channels/"), {"name": "a", "project": str(project.id)}, format="json")
        assert res.status_code == 400 and res.data["project"] == ["Project not found."]
        in_project(member2, ADMIN)
        project.archived_at = timezone.now()
        project.save()
        res = member2.client.post(url("channels/"), {"name": "b", "project": str(project.id)}, format="json")
        assert res.status_code == 400 and res.data["project"] == ["Project not found."]
        assert not Channel.objects.filter(name__in=["a", "b"]).exists()

    def test_a_channel_admin_in_the_project_links_and_unlinks(self, member, in_project, project, make_channel, url):
        in_project(member, MEMBER)
        channel = make_channel(admins=[member.user])
        res = member.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
        assert res.status_code == 200 and res.data["project"] == project.id
        res = member.client.patch(url(f"channels/{channel.id}/"), {"project": None}, format="json")
        assert res.status_code == 200 and res.data["project"] is None

    def test_a_workspace_admin_in_the_project_can_link_a_public_channel(
        self, admin, in_project, project, make_channel, url
    ):
        in_project(admin, ADMIN)
        channel = make_channel()
        res = admin.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
        assert res.status_code == 200 and res.data["project"] == project.id

    def test_linking_needs_the_project(self, admin, member, in_project, project, make_channel, url):
        channel = make_channel(admins=[member.user])
        # A channel admin outside the project, or only a guest in it.
        assert member.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json").data[
            "project"
        ] == ["Project not found."]
        in_project(member, GUEST)
        res = member.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
        assert res.status_code == 400
        # A workspace admin isn't exempt.
        res = admin.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
        assert res.status_code == 400
        channel.refresh_from_db()
        assert channel.project_id is None

    def test_linking_needs_a_channel_admin(self, member, in_project, project, make_channel, url):
        in_project(member, ADMIN)
        channel = make_channel(members=[member.user])
        res = member.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
        assert res.status_code == 403

    def test_an_admin_outside_the_project_can_keep_or_clear_the_link(
        self, member, member2, in_project, project, make_channel, url
    ):
        channel = make_channel(admins=[member.user])
        channel.project = project
        channel.save()
        res = member.client.patch(
            url(f"channels/{channel.id}/"), {"name": "renamed", "project": str(project.id)}, format="json"
        )
        assert res.status_code == 200 and res.data["project"] == project.id
        res = member.client.patch(url(f"channels/{channel.id}/"), {"project": None}, format="json")
        assert res.status_code == 200 and res.data["project"] is None

    def test_another_workspaces_project_is_not_found(self, member, other_workspace, make_channel, url):
        foreign = Project.objects.create(name="Foreign", identifier="FRGN", workspace=other_workspace)
        ProjectMember.objects.create(project=foreign, workspace=other_workspace, member=member.user, role=ADMIN)
        channel = make_channel(admins=[member.user])
        res = member.client.patch(url(f"channels/{channel.id}/"), {"project": str(foreign.id)}, format="json")
        assert res.status_code == 400 and res.data["project"] == ["Project not found."]

    def test_dms_and_archived_channels_cant_be_linked(
        self, member, member2, in_project, project, workspace, make_channel, url
    ):
        in_project(member, ADMIN)
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        assert (
            member.client.patch(url(f"channels/{dm.id}/"), {"project": str(project.id)}, format="json").status_code
            == 409
        )
        archived = make_channel(admins=[member.user])
        member.client.post(url(f"channels/{archived.id}/archive/"))
        res = member.client.patch(url(f"channels/{archived.id}/"), {"project": str(project.id)}, format="json")
        assert res.status_code == 409
        # Nor directly in the database.
        dm.project = project
        with pytest.raises(IntegrityError), transaction.atomic():
            dm.save()

    def test_linking_is_announced_as_a_channel_update(self, member, in_project, project, make_channel, url):
        in_project(member, MEMBER)
        channel = make_channel(admins=[member.user])
        with mock.patch("plane.chat.views.channel.publish_on_commit") as publish:
            member.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
            member.client.patch(url(f"channels/{channel.id}/"), {"project": str(project.id)}, format="json")
        # The second changed nothing.
        assert [call.args[0]["type"] for call in publish.call_args_list] == ["channel.updated"]


@pytest.mark.contract
@pytest.mark.django_db
class TestStateChangePosts:
    def test_a_state_change_is_posted_to_the_linked_channel(
        self, member, project, make_channel, make_issue, move, scheduled, run_feed
    ):
        channel = make_channel(members=[member.user])
        channel.project = project
        channel.save()
        issue = make_issue()
        move(issue, "review")
        assert scheduled == [(str(project.id), project_feed.POST_DELAY_SECONDS)]
        # Nothing yet: the run posts it.
        assert _feed(channel) == []

        run_feed()
        [message] = _feed(channel)
        assert _shown(message) == f"<p>{_key(issue)} moved to In Review</p>"
        # What everyone reads (search, export, the inbox) names no work item.
        assert message.body_html == "<p>1 work item changed state</p>"
        assert _key(issue) not in message.body_stripped
        assert message.sender_id is None and message.sender_agent is None
        assert list(message.references.values_list("issue_id", flat=True)) == [issue.id]

    def test_only_after_the_change_commits(
        self, project, make_channel, make_issue, states, create_user, scheduled, django_capture_on_commit_callbacks
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        issue = make_issue()
        with django_capture_on_commit_callbacks(execute=False) as callbacks:
            issue_activity(
                type="issue.activity.updated",
                requested_data=json.dumps({"state_id": str(states["done"].id)}),
                current_instance=json.dumps({"state_id": str(states["todo"].id)}),
                issue_id=str(issue.id),
                actor_id=str(create_user.id),
                project_id=str(project.id),
                epoch=int(timezone.now().timestamp()),
                notification=False,
            )
            assert scheduled == []
            assert redis_instance().llen(project_feed._pending_key(project.id)) == 0
        assert len(callbacks) == 1
        # A rollback drops the callback; a commit runs it.
        callbacks[0]()
        assert scheduled == [(str(project.id), project_feed.POST_DELAY_SECONDS)]
        assert redis_instance().llen(project_feed._pending_key(project.id)) == 1

    def test_only_state_changes_are_posted(
        self, project, make_channel, make_issue, change, states, scheduled, run_feed
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        issue = make_issue()
        change(issue, {"name": "Renamed", "priority": "urgent"}, {"name": issue.name, "priority": "none"})
        # The state it already had.
        change(issue, {"state_id": str(issue.state_id)}, {"state_id": str(issue.state_id)})
        assert scheduled == []
        run_feed()
        assert _feed(channel) == []

    def test_external_api_keys_and_auto_close_are_state_changes(
        self, project, make_channel, make_issue, change, states, scheduled, run_feed
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        api_issue, closed_issue = make_issue(), make_issue()
        # The external API (and the MCP server through it) sends `state`; Plane's auto-close sends `closed_to`.
        Issue.objects.filter(pk=api_issue.pk).update(state=states["progress"])
        Issue.objects.filter(pk=closed_issue.pk).update(state=states["done"])
        change(api_issue, {"state": str(states["progress"].id)}, {"state": str(states["todo"].id)})
        change(closed_issue, {"closed_to": str(states["done"].id)})
        run_feed()
        [message] = _feed(channel)
        assert _shown(message) == (
            f"<p>{_key(api_issue)} moved to In Progress</p><p>{_key(closed_issue)} moved to Done</p>"
        )

    def test_a_bulk_change_is_one_capped_message(self, project, make_channel, make_issue, move, scheduled, run_feed):
        channel = make_channel()
        channel.project = project
        channel.save()
        issues = [make_issue(name=f"item {n}") for n in range(25)]
        for issue in issues:
            move(issue, "done")
        assert len(scheduled) == 1
        run_feed()
        [message] = _feed(channel)
        lines = _shown(message).split("</p><p>")
        assert len(lines) == project_feed.MAX_LINES_PER_POST + 1
        assert lines[0] == f"<p>{_key(issues[0])} moved to Done"
        assert lines[-1] == "and 15 more work items changed state</p>"
        assert message.references.count() == project_feed.MAX_LINES_PER_POST

    def test_one_message_names_the_last_state_and_skips_round_trips(
        self, project, make_channel, make_issue, move, run_feed, scheduled
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        moved, back = make_issue(), make_issue()
        move(moved, "progress")
        move(back, "progress")
        move(moved, "review")
        move(back, "todo")
        run_feed()
        [message] = _feed(channel)
        assert _shown(message) == f"<p>{_key(moved)} moved to In Review</p>"

    def test_the_next_change_after_a_run_schedules_another(
        self, project, make_channel, make_issue, move, run_feed, scheduled
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        issue = make_issue()
        move(issue, "progress")
        run_feed()
        move(issue, "done")
        assert len(scheduled) == 2
        run_feed()
        assert [_shown(m) for m in _feed(channel)] == [
            f"<p>{_key(issue)} moved to In Progress</p>",
            f"<p>{_key(issue)} moved to Done</p>",
        ]
        # A run with nothing noted posts nothing.
        run_feed()
        assert len(_feed(channel)) == 2

    def test_each_linked_channel_gets_it_once(
        self, workspace, project, make_channel, make_issue, move, run_feed, scheduled
    ):
        first, second = make_channel(), make_channel(ChannelKind.PRIVATE)
        other_project = Project.objects.create(name="Other", identifier="OTH", workspace=workspace)
        unlinked, elsewhere = make_channel(), make_channel()
        elsewhere.project = other_project
        elsewhere.save()
        for channel in (first, second):
            channel.project = project
            channel.save()
        move(make_issue(), "review")
        run_feed()
        assert (len(_feed(first)), len(_feed(second)), len(_feed(unlinked)), len(_feed(elsewhere))) == (1, 1, 0, 0)

    def test_nothing_is_noted_for_a_project_without_channels(self, project, make_issue, move, scheduled):
        move(make_issue(), "review")
        assert scheduled == []
        assert redis_instance().exists(project_feed._pending_key(project.id)) == 0

    @pytest.mark.parametrize("what", ["channel archived", "channel unlinked", "project archived", "project deleted"])
    def test_a_link_no_longer_valid_at_post_time_posts_nothing(
        self, project, make_channel, make_issue, move, run_feed, scheduled, what
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        move(make_issue(), "review")
        if what == "channel archived":
            channel.archived_at = timezone.now()
            channel.save()
        elif what == "channel unlinked":
            channel.project = None
            channel.save()
        elif what == "project archived":
            project.archived_at = timezone.now()
            project.save()
        else:
            Project.objects.filter(pk=project.pk).update(deleted_at=timezone.now())
        run_feed()
        assert Message.objects.filter(channel=channel).count() == 0

    def test_a_channel_archived_while_the_run_works_gets_nothing(
        self, project, make_channel, make_issue, move, run_feed, scheduled
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        move(make_issue(), "review")
        work_out_changes = project_feed._changes

        def archive_meanwhile(*args):
            Channel.objects.filter(pk=channel.pk).update(archived_at=timezone.now())
            return work_out_changes(*args)

        with mock.patch.object(project_feed, "_changes", side_effect=archive_meanwhile):
            run_feed()
        assert Message.objects.filter(channel=channel).count() == 0

    def test_an_activity_that_names_the_same_state_is_not_noted(
        self, project, make_channel, make_issue, states, scheduled, django_capture_on_commit_callbacks
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        issue = make_issue()
        same = IssueActivity(
            issue=issue,
            project=project,
            workspace=project.workspace,
            field="state",
            verb="updated",
            old_identifier=states["todo"].id,
            new_identifier=states["todo"].id,
            new_value="Todo",
        )
        with django_capture_on_commit_callbacks(execute=True) as callbacks:
            project_feed.queue_state_changes([same])
        assert callbacks == [] and scheduled == []

    def test_archived_draft_and_intake_work_items_are_left_out(
        self, project, workspace, make_channel, make_issue, move, run_feed, scheduled
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        archived, draft, listed = make_issue(), make_issue(is_draft=True), make_issue()
        triage = State.objects.create(
            name="Triage", group="triage", color="#000", project=project, workspace=workspace, is_triage=True
        )
        intake = make_issue()
        for issue in (archived, draft, listed, intake):
            move(issue, "review")
        Issue.objects.filter(pk=archived.pk).update(archived_at=timezone.now())
        Issue.objects.filter(pk=intake.pk).update(state=triage)
        run_feed()
        [message] = _feed(channel)
        assert _shown(message) == f"<p>{_key(listed)} moved to In Review</p>"

    def test_state_names_are_escaped(self, project, make_channel, make_issue, states, move, run_feed, scheduled):
        channel = make_channel()
        channel.project = project
        channel.save()
        State.objects.filter(pk=states["review"].pk).update(name="<b>Review</b>")
        states["review"].refresh_from_db()
        move(make_issue(), "review")
        run_feed()
        assert "&lt;b&gt;Review&lt;/b&gt;" in _shown(_feed(channel)[0])

    def test_changes_saved_out_of_order_name_the_state_the_work_item_is_in(
        self, project, make_channel, make_issue, change, states, run_feed, scheduled
    ):
        channel = make_channel()
        channel.project = project
        channel.save()
        issue = make_issue()
        # Todo -> In Progress -> Done, but the second change's activity was saved first.
        Issue.objects.filter(pk=issue.pk).update(state=states["done"])
        change(issue, {"state_id": str(states["done"].id)}, {"state_id": str(states["progress"].id)})
        change(issue, {"state_id": str(states["progress"].id)}, {"state_id": str(states["todo"].id)})
        run_feed()
        [message] = _feed(channel)
        assert _shown(message) == f"<p>{_key(issue)} moved to Done</p>"

    def test_it_is_live_and_counts_as_unread_but_mentions_nobody(
        self, member, project, make_channel, make_issue, move, run_feed, scheduled, url, published
    ):
        channel = make_channel(members=[member.user])
        channel.project = project
        channel.save()
        move(make_issue(), "review")
        published.clear()
        run_feed()
        [message] = _feed(channel)
        assert published.events == [
            {
                "type": "message.created",
                "workspace_id": str(channel.workspace_id),
                "channel_id": str(channel.id),
                "message_id": str(message.id),
            }
        ]
        assert member.client.get(url(f"channels/{channel.id}/")).data["unread_count"] == 1
        assert not Notification.objects.filter(entity_identifier=message.id).exists()


@pytest.mark.contract
@pytest.mark.django_db
class TestReadingThePosts:
    @pytest.fixture
    def posted(self, member, member2, admin, project, make_channel, make_issue, move, run_feed, scheduled):
        channel = make_channel(members=[member.user, member2.user], admins=[admin.user])
        channel.project = project
        channel.save()
        issue = make_issue(name="Secret title")
        move(issue, "review")
        run_feed()
        return channel, _feed(channel)[0], issue

    def test_the_card_is_only_for_readers_who_may_see_the_work_item(self, member, member2, in_project, posted, url):
        channel, message, issue = posted
        in_project(member, MEMBER)
        mine = member.client.get(url(f"channels/{channel.id}/messages/{message.id}/")).data
        theirs = member2.client.get(url(f"channels/{channel.id}/messages/{message.id}/")).data
        assert mine["system_event"] == "work_item_state" and mine["sender"] is None
        assert [card["name"] for card in mine["references"]] == ["Secret title"]
        assert mine["body_html"] == f"<p>{_key(issue)} moved to In Review</p>"
        # Outside the project: that a work item changed state, nothing more.
        assert theirs["references"] == []
        assert "Secret title" not in json.dumps(theirs, default=str)
        assert _key(issue) not in json.dumps(theirs, default=str)
        assert theirs["body_html"] == "<p>1 work item changed state</p>"

    def test_each_reader_gets_the_lines_for_their_own_work_items(
        self, member, member2, in_project, project, make_channel, make_issue, move, run_feed, scheduled, url
    ):
        channel = make_channel(members=[member.user, member2.user])
        channel.project = project
        channel.save()
        theirs, others = make_issue(), (make_issue(), make_issue())
        for issue in (theirs, *others):
            move(issue, "review")
        Issue.objects.filter(pk=theirs.pk).update(created_by=member2.user)
        run_feed()
        [message] = _feed(channel)
        in_project(member, MEMBER)
        in_project(member2, GUEST)
        detail = url(f"channels/{channel.id}/messages/{message.id}/")
        assert member.client.get(detail).data["body_html"] == "".join(
            f"<p>{_key(issue)} moved to In Review</p>" for issue in (theirs, *others)
        )
        # A project guest sees only the work items they created, as in Plane.
        guest_view = member2.client.get(detail).data
        assert guest_view["body_html"] == (
            f"<p>{_key(theirs)} moved to In Review</p><p>and 2 more work items changed state</p>"
        )
        assert [card["key"] for card in guest_view["references"]] == [_key(theirs)]

    def test_a_removed_post_shows_nothing(self, member, admin, in_project, posted, url):
        channel, message, _ = posted
        in_project(member, MEMBER)
        detail = url(f"channels/{channel.id}/messages/{message.id}/")
        assert admin.client.delete(detail).status_code == 204
        assert member.client.get(detail).data["body_html"] == ""

    def test_a_project_guest_sees_a_card_only_where_plane_lets_them(self, member, in_project, project, posted, url):
        channel, message, _ = posted
        in_project(member, GUEST)
        assert member.client.get(url(f"channels/{channel.id}/messages/{message.id}/")).data["references"] == []
        project.guest_view_all_features = True
        project.save()
        assert len(member.client.get(url(f"channels/{channel.id}/messages/{message.id}/")).data["references"]) == 1

    def test_nobody_edits_it_and_only_an_admin_removes_it(self, member, admin, in_project, posted, url):
        channel, message, issue = posted
        in_project(member, ADMIN)
        detail = url(f"channels/{channel.id}/messages/{message.id}/")
        assert member.client.patch(detail, {"body_html": "<p>x</p>"}, format="json").status_code == 403
        assert admin.client.patch(detail, {"body_html": "<p>x</p>"}, format="json").status_code == 403
        assert member.client.delete(detail).status_code == 403
        assert admin.client.delete(detail).status_code == 204

    def test_it_cant_be_turned_into_a_work_item(self, member, in_project, posted, url):
        channel, message, issue = posted
        in_project(member, MEMBER)
        res = member.client.post(
            url(f"channels/{channel.id}/messages/{message.id}/work-items/"), {"issue_id": str(issue.id)}, format="json"
        )
        assert res.status_code == 400
        assert MessageReference.objects.filter(message=message, created_from_message=True).count() == 0

    def test_it_can_be_replied_to(self, member, posted, url):
        channel, message, _ = posted
        res = member.client.post(
            url(f"channels/{channel.id}/messages/"),
            {"body_html": "<p>nice</p>", "parent_id": str(message.id)},
            format="json",
        )
        assert res.status_code == 201
