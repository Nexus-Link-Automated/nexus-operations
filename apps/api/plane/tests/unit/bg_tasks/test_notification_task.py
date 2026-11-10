# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Issue description mentions reach the mentioned user, driven through issue_activity as the API does."""

import json
from types import SimpleNamespace
from unittest import mock

import pytest
from django.utils import timezone

from plane.bgtasks.email_notification_task import create_payload
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.notification_task import notifications
from plane.db.models import (
    EmailNotificationLog,
    Issue,
    IssueComment,
    IssueMention,
    IssueSubscriber,
    Notification,
    Project,
    ProjectMember,
    State,
    User,
    UserNotificationPreference,
)

pytestmark = pytest.mark.unit

CREATED = "issue.activity.created"
UPDATED = "issue.activity.updated"
EMPTY_DESCRIPTION = {"description_html": "<p></p>"}


@pytest.fixture
def scope(workspace, create_user):
    project = Project.objects.create(name="Home", identifier="HOME", workspace=workspace)
    state = State.objects.create(
        name="Backlog", color="#000000", group="backlog", default=True, project=project, workspace=workspace
    )
    mentioned = User.objects.create(email="mentioned@plane.so", username="mentioned", display_name="mentioned")
    subscriber = User.objects.create(email="subscriber@plane.so", username="subscriber", display_name="subscriber")
    for member in (create_user, mentioned, subscriber):
        ProjectMember.objects.create(project=project, member=member, workspace=workspace, role=15)

    issue = Issue.objects.create(name="Home issue", project=project, workspace=workspace, state=state)
    Issue.objects.filter(pk=issue.pk).update(created_by=create_user)

    return SimpleNamespace(
        actor=create_user, mentioned=mentioned, subscriber=subscriber, workspace=workspace, project=project, issue=issue
    )


def _description_mentioning(user):
    return (
        "<p>Please look at this "
        f'<mention-component entity_name="user_mention" entity_identifier="{user.id}"></mention-component></p>'
    )


def _subscribe(scope, user):
    IssueSubscriber.objects.create(issue=scope.issue, subscriber=user, project=scope.project, workspace=scope.workspace)


def _save(scope, type, requested_data, current_instance=None):
    """Run issue_activity the way the issue views do, with the notification task inline."""
    with mock.patch("plane.bgtasks.issue_activities_task.notifications.delay", side_effect=notifications):
        issue_activity(
            type=type,
            requested_data=json.dumps(requested_data),
            current_instance=json.dumps(current_instance) if current_instance is not None else None,
            issue_id=str(scope.issue.id),
            actor_id=str(scope.actor.id),
            project_id=str(scope.project.id),
            epoch=int(timezone.now().timestamp()),
            notification=True,
        )


def _in_app_mentions(user):
    return Notification.objects.filter(receiver=user, sender="in_app:issue_activities:mentioned")


def _mention_emails(user):
    return EmailNotificationLog.objects.filter(receiver=user, data__issue_activity__field="mention")


def test_mention_email_goes_to_the_mentioned_user_and_not_a_subscriber(scope):
    _subscribe(scope, scope.subscriber)

    _save(scope, UPDATED, {"description_html": _description_mentioning(scope.mentioned)}, EMPTY_DESCRIPTION)

    assert _mention_emails(scope.mentioned).count() == 1
    assert not _mention_emails(scope.subscriber).exists()


def test_mention_email_reaches_the_mentioned_user_when_the_issue_has_no_subscribers(scope):
    _save(scope, UPDATED, {"description_html": _description_mentioning(scope.mentioned)}, EMPTY_DESCRIPTION)

    assert _mention_emails(scope.mentioned).count() == 1


def test_mention_saved_alongside_another_change_emails_the_mentioned_user(scope):
    _subscribe(scope, scope.subscriber)

    # The priority activity lands last, so the mention is not built from the description activity
    _save(
        scope,
        UPDATED,
        {"description_html": _description_mentioning(scope.mentioned), "priority": "high"},
        {**EMPTY_DESCRIPTION, "priority": "none"},
    )

    assert _mention_emails(scope.mentioned).exists()
    assert not _mention_emails(scope.subscriber).exists()


def test_mention_added_on_a_follow_up_save_is_notified_once(scope):
    draft = {"description_html": "<p>draft</p>"}
    mentioning = {"description_html": _description_mentioning(scope.mentioned)}

    _save(scope, UPDATED, draft, EMPTY_DESCRIPTION)
    _save(scope, UPDATED, mentioning, draft)

    assert _in_app_mentions(scope.mentioned).count() == 1
    email = _mention_emails(scope.mentioned).get()
    assert email.data["issue_activity"]["new_value"] == mentioning["description_html"]
    assert IssueMention.objects.filter(issue=scope.issue, mention=scope.mentioned).exists()

    # Autosaving more text after the mention does not notify again
    _save(scope, UPDATED, {"description_html": f"{mentioning['description_html']}<p>more</p>"}, mentioning)

    assert _in_app_mentions(scope.mentioned).count() == 1
    assert _mention_emails(scope.mentioned).count() == 1


def test_mention_at_creation_is_notified_once(scope):
    description = _description_mentioning(scope.mentioned)

    _save(scope, CREATED, {"name": "Home issue", "description_html": description})

    assert _in_app_mentions(scope.mentioned).count() == 1
    email = _mention_emails(scope.mentioned).get()
    assert IssueMention.objects.filter(issue=scope.issue, mention=scope.mentioned).exists()

    # The email task has to be able to read what was stored and quote the description
    actor_id = str(scope.actor.id)
    assert create_payload({actor_id: [email.data]})[actor_id]["mention"]["new_value"] == [description]


ALL_EMAILS_OFF = {"property_change": False, "state_change": False, "comment": False, "issue_completed": False}


def _state(scope, group):
    return State.objects.create(
        name=group.title(), color="#000000", group=group, project=scope.project, workspace=scope.workspace
    )


def _set_email_preferences(user, **enabled):
    UserNotificationPreference.objects.filter(user=user).update(**{**ALL_EMAILS_OFF, **enabled})


def _emails(user, field):
    return EmailNotificationLog.objects.filter(receiver=user, data__issue_activity__field=field)


def _in_app(user, field):
    return Notification.objects.filter(receiver=user, data__issue_activity__field=field)


def _comment(scope):
    comment = IssueComment.objects.create(
        issue=scope.issue,
        project=scope.project,
        workspace=scope.workspace,
        actor=scope.actor,
        comment_html="<p>note</p>",
    )
    _save(scope, "comment.activity.created", {"id": str(comment.id), "comment_html": comment.comment_html})


def _change_state(scope, group):
    state = _state(scope, group)
    _save(scope, UPDATED, {"state_id": str(state.id)}, {"state_id": str(scope.issue.state_id)})


def _change_priority(scope):
    _save(scope, UPDATED, {"priority": "high"}, {"priority": "none"})


@pytest.mark.parametrize(
    "act, field, enabled, emailed",
    [
        (_comment, "comment", {"property_change": True}, False),
        (_comment, "comment", {"comment": True}, True),
        (lambda scope: _change_state(scope, "started"), "state", {"property_change": True}, False),
        (lambda scope: _change_state(scope, "started"), "state", {"issue_completed": True}, False),
        (lambda scope: _change_state(scope, "started"), "state", {"state_change": True}, True),
        (lambda scope: _change_state(scope, "completed"), "state", {"property_change": True}, False),
        (lambda scope: _change_state(scope, "completed"), "state", {"issue_completed": True}, True),
        (_change_priority, "priority", {"property_change": True}, True),
        (_change_priority, "priority", {"state_change": True, "comment": True, "issue_completed": True}, False),
    ],
)
def test_email_follows_the_preference_for_that_kind_of_change(scope, act, field, enabled, emailed):
    _subscribe(scope, scope.subscriber)
    _set_email_preferences(scope.subscriber, **enabled)

    act(scope)

    assert _emails(scope.subscriber, field).exists() is emailed
    assert _in_app(scope.subscriber, field).exists()
