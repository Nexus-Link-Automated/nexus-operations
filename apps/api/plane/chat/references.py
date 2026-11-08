# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Work item references in messages.

Typing or pasting `EMP-142` in a message records a `MessageReference`. Anyone can
write a reference; what it shows is decided per reader when the message is read:
someone without access to the work item gets nothing for it, and sees only the text
the sender typed, exactly as they would for a key that doesn't exist.
"""

import re

from bs4 import BeautifulSoup

from plane.app.permissions.base import ROLE
from plane.chat.models import MessageReference
from plane.db.models import Issue, ProjectMember
from plane.utils.exception_logger import log_exception

MAX_REFERENCES_PER_MESSAGE = 10

# A project identifier (uppercase, up to 12 characters) and a sequence number short enough for an integer column.
_WORK_ITEM_KEY = re.compile(r"(?<![\w-])([A-Z0-9ÇŞĞİÖÜ]{1,12})-(\d{1,9})(?![\w-])")
# Text in these is an example, a URL, or a person, not a reference.
_NOT_REFERENCES = ["code", "pre", "a", "mention-component"]


def _work_item_keys(html):
    """The distinct `(identifier, sequence)` pairs written in `html`, in order, up to the limit."""
    soup = BeautifulSoup(html or "", "html.parser")
    for tag in soup.find_all(_NOT_REFERENCES):
        tag.decompose()
    keys = []
    for identifier, sequence in _WORK_ITEM_KEY.findall(soup.get_text(" ")):
        key = (identifier, int(sequence))
        if key not in keys:
            keys.append(key)
        if len(keys) == MAX_REFERENCES_PER_MESSAGE:
            break
    return keys


def _resolve(workspace_id, keys):
    """The IDs of the work items `keys` name in this workspace, in the order written."""
    if not keys:
        return []
    found = {
        (identifier, sequence): issue_id
        for issue_id, identifier, sequence in Issue.objects.filter(
            workspace_id=workspace_id,
            project__identifier__in={identifier for identifier, _ in keys},
            sequence_id__in={sequence for _, sequence in keys},
        ).values_list("id", "project__identifier", "sequence_id")
    }
    return [found[key] for key in keys if key in found]


def _sync(message):
    wanted = _resolve(message.workspace_id, _work_item_keys(message.body_html))
    stale = message.references.filter(created_from_message=False).exclude(issue_id__in=wanted)
    if stale.exists():
        stale.delete()
    existing = set(message.references.values_list("issue_id", flat=True))
    MessageReference.objects.bulk_create(
        [
            MessageReference(workspace_id=message.workspace_id, message=message, issue_id=issue_id)
            for issue_id in wanted
            if issue_id not in existing
        ]
    )


def _can_see(issue, role, user):
    return role > ROLE.GUEST.value or issue.project.guest_view_all_features or issue.created_by_id == user.id


def visible_work_item(issue_id, user, workspace_id):
    """The work item, if `user` may see it. See `references_for` for who may."""
    issue = (
        Issue.issue_objects.filter(pk=issue_id, workspace_id=workspace_id, project__deleted_at__isnull=True)
        .select_related("project")
        .first()
    )
    if issue is None:
        return None
    role = (
        ProjectMember.objects.filter(project_id=issue.project_id, member=user, is_active=True)
        .values_list("role", flat=True)
        .first()
    )
    return issue if role is not None and _can_see(issue, role, user) else None


def sync_references(message):
    """Make `message`'s references match its body. The message is already saved, so this never raises."""
    try:
        _sync(message)
    except Exception as error:
        log_exception(error)


def references_for(message_ids, user):
    """`{message_id: [work item]}` for the references `user` may see, in a fixed number of queries.

    Access is Plane's own: an active member of the project, and a guest only sees work items they created unless the
    project lets guests see everything. Archived, draft and intake work items count as not there.
    """
    references = list(
        MessageReference.objects.filter(message_id__in=message_ids)
        .select_related("issue__state", "issue__project")
        .order_by("created_at")
    )
    if not references:
        return {}
    roles = dict(
        ProjectMember.objects.filter(
            project_id__in={reference.issue.project_id for reference in references}, member=user, is_active=True
        ).values_list("project_id", "role")
    )
    listable = set(
        Issue.issue_objects.filter(
            pk__in={reference.issue_id for reference in references},
            project_id__in=list(roles),
            project__deleted_at__isnull=True,
        ).values_list("pk", flat=True)
    )
    visible = {}
    for reference in references:
        issue = reference.issue
        if issue.pk not in listable:
            continue
        if not _can_see(issue, roles[issue.project_id], user):
            continue
        visible.setdefault(reference.message_id, []).append(
            {
                "id": str(issue.pk),
                "project": str(issue.project_id),
                "key": f"{issue.project.identifier}-{issue.sequence_id}",
                "name": issue.name,
                "priority": issue.priority,
                "state": {"name": issue.state.name, "group": issue.state.group, "color": issue.state.color}
                if issue.state
                else None,
            }
        )
    return visible
