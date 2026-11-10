# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Work item state changes, posted to the channels linked to the work item's project.

Plane records every change to a work item in the `issue_activity` Celery task, however it was made: in
the app, through the external API or the MCP server, or by Plane's own auto-close. When a run has saved
its activities it calls `queue_state_changes`, which notes the state changes among them once the run's
transaction commits. The first change noted in a quiet project schedules `post_project_feed`
`POST_DELAY_SECONDS` later, and that run posts everything noted meanwhile as one message per linked
channel. So a bulk change, or an agent working through a list, makes one message instead of dozens.

What is posted:

- One line per work item, "EMP-142 moved to In Review", with the state it is in when the run posts. A work
  item that ends the batch where it started posts nothing, and neither does a "change" to the state it
  already had. Up to `MAX_LINES_PER_POST` lines; any more are counted on a last line.
- Each reader sees the lines only for the work items they may see, and a count of the others
  (`body_for_reader`): not everyone who can read the channel is in the project. Each work item's card
  (`references.py`) adds its title and the rest, for the same readers.
- Nothing, if by the time of the run the project is deleted or archived, or the channel is archived or no
  longer linked to it. Archived, draft and intake work items are left out.

The messages have `system_event` set and no sender, so nobody can edit them; channel admins can remove them.

Not posted: accepting a work item from intake moves it out of triage without a state activity.

Redis holds what is noted until the run: a list of activity IDs per project, and a flag saying a run is
scheduled. A run that never happens (a worker lost) leaves the flag to expire, and the next change
schedules another run that posts what was left. Losing Redis loses only the posts, never a change.
"""

from html import escape

from celery import shared_task
from django.db import transaction

from plane.chat.events import EventType, message_event, publish_on_commit
from plane.chat.models import Channel, Message, MessageReference, MessageSystemEvent
from plane.chat.models.channel import NAMED_KINDS
from plane.chat.references import MAX_REFERENCES_PER_MESSAGE
from plane.db.models import Issue, IssueActivity, Project
from plane.settings.redis import redis_instance
from plane.utils.exception_logger import log_exception

POST_DELAY_SECONDS = 10
# Each line's work item gets a card, and a message holds at most this many.
MAX_LINES_PER_POST = MAX_REFERENCES_PER_MESSAGE
# How long noted changes wait for a run, and how long a scheduled run blocks scheduling another.
_PENDING_TTL_SECONDS = 60 * 60
_SCHEDULED_TTL_SECONDS = POST_DELAY_SECONDS + 5 * 60


def _pending_key(project_id):
    return f"chat:project-feed:{project_id}:pending"


def _scheduled_key(project_id):
    return f"chat:project-feed:{project_id}:scheduled"


def _linked_channels(project_id):
    return Channel.objects.filter(project_id=project_id, kind__in=NAMED_KINDS, archived_at__isnull=True)


def _is_state_change(activity):
    return (
        activity.field == "state"
        and activity.verb == "updated"
        and activity.new_identifier is not None
        and activity.old_identifier != activity.new_identifier
    )


def _note(project_id, activity_ids):
    if not _linked_channels(project_id).exists():
        return
    client = redis_instance()
    with client:
        pending = _pending_key(project_id)
        client.pipeline().rpush(pending, *activity_ids).expire(pending, _PENDING_TTL_SECONDS).execute()
        if client.set(_scheduled_key(project_id), 1, nx=True, ex=_SCHEDULED_TTL_SECONDS):
            post_project_feed.apply_async(args=[str(project_id)], countdown=POST_DELAY_SECONDS)


def queue_state_changes(activities):
    """Note the state changes among `activities` (just saved by `issue_activity`) for posting. Never raises.

    Noted once the current transaction commits, so a run that rolls back posts nothing.
    """
    by_project = {}
    for activity in activities:
        if _is_state_change(activity):
            by_project.setdefault(str(activity.project_id), []).append(str(activity.pk))
    if not by_project:
        return

    def note():
        for project_id, activity_ids in by_project.items():
            try:
                _note(project_id, activity_ids)
            except Exception as error:
                log_exception(error)

    transaction.on_commit(note)


def _take_pending(project_id):
    """Everything noted for the project, removed in the same step as the flag, so a change noted after it schedules
    the next run instead of being lost."""
    client = redis_instance()
    with client:
        ids, _, _ = (
            client.pipeline()
            .lrange(_pending_key(project_id), 0, -1)
            .delete(_pending_key(project_id))
            .delete(_scheduled_key(project_id))
            .execute()
        )
    return [raw.decode() for raw in ids]


def _changes(project, activity_ids):
    """`[(issue, state name)]` for each work item whose state ended up somewhere new, in the order they got there.

    The state named is the work item's state now, not the last activity's: activities are saved by Celery workers
    that can run out of order, so the last one saved needn't be the last change made.
    """
    activities = IssueActivity.objects.filter(pk__in=activity_ids, project=project, field="state").order_by(
        "epoch", "created_at", "id"
    )
    first_state, last = {}, {}
    for activity in activities:
        if not _is_state_change(activity):
            continue
        first_state.setdefault(activity.issue_id, activity.old_identifier)
        # Re-inserted, so the dict ends up ordered by each work item's last change.
        last.pop(activity.issue_id, None)
        last[activity.issue_id] = activity
    issues = Issue.issue_objects.filter(pk__in=list(last), project=project).select_related("state").in_bulk()
    return [
        (issues[issue_id], issues[issue_id].state.name if issues[issue_id].state else "")
        for issue_id in last
        if issue_id in issues and str(issues[issue_id].state_id) != str(first_state[issue_id])
    ]


def _count_line(count, more):
    noun = "work item" if count == 1 else "work items"
    return f"<p>and {count} more {noun} changed state</p>" if more else f"<p>{count} {noun} changed state</p>"


def _system_data(changes):
    """What a post records, so each reader is shown only the lines they may see (`body_for_reader`)."""
    return {
        "lines": [{"issue": str(issue.pk), "state": state_name} for issue, state_name in changes[:MAX_LINES_PER_POST]],
        "more": max(len(changes) - MAX_LINES_PER_POST, 0),
    }


def body_for_reader(message, visible_keys):
    """A state-change post's body as one reader may see it, given `{work item id: key}` for the work items they may see.

    A line names a work item's key, which Plane shows only to those who may see the work item (a secret project's
    identifier included), so each reader gets the lines for their own work items and a count of the rest. What is
    stored in `body_html` is only that count, since search, export and the inbox read it for everyone.
    """
    data = message.system_data if isinstance(message.system_data, dict) else {}
    lines, hidden = [], data.get("more", 0)
    for line in data.get("lines", []):
        key = visible_keys.get(line.get("issue"))
        if key is None:
            hidden += 1
        else:
            lines.append(f"<p>{escape(key)} moved to {escape(line.get('state') or '')}</p>")
    if hidden:
        lines.append(_count_line(hidden, more=bool(lines)))
    return "".join(lines) or message.body_html


def post_state_changes(project_id, activity_ids):
    """Post the state changes in `activity_ids` to every channel linked to the project, once each."""
    project = Project.objects.filter(pk=project_id, archived_at__isnull=True).first()
    if project is None:
        return
    channels = list(_linked_channels(project.pk))
    if not channels:
        return
    changes = _changes(project, activity_ids)
    if not changes:
        return
    body_html = _count_line(len(changes), more=False)
    system_data = _system_data(changes)
    shown = [issue for issue, _ in changes[:MAX_LINES_PER_POST]]
    for candidate in channels:
        with transaction.atomic():
            # Checked again under the lock that archiving and editing the channel take, so a channel archived or
            # unlinked since it was listed gets nothing.
            channel = _linked_channels(project.pk).select_for_update().filter(pk=candidate.pk).first()
            if channel is None:
                continue
            message = Message.objects.create(
                channel=channel,
                system_event=MessageSystemEvent.WORK_ITEM_STATE,
                body_html=body_html,
                system_data=system_data,
            )
            MessageReference.objects.bulk_create(
                [MessageReference(workspace_id=message.workspace_id, message=message, issue=issue) for issue in shown]
            )
            publish_on_commit(message_event(EventType.MESSAGE_CREATED, message))


@shared_task
def post_project_feed(project_id):
    """Post what has been noted for the project since its last run."""
    try:
        activity_ids = _take_pending(project_id)
        if activity_ids:
            post_state_changes(project_id, activity_ids)
    except Exception as error:
        log_exception(error)
