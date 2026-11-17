# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Apply a coding job's result to its work item: the only place an outcome moves a work item or comments on it.

The table this follows (the build plan's "Actions and outcomes"):

| Action             | Outcome       | Column    | Comment                                                   |
| ------------------ | ------------- | --------- | --------------------------------------------------------- |
| fix_bug            | fixed         | In review | PR link and a summary of the fix                          |
| fix_bug            | could_not_fix | stays put | what was tried and why it stopped                         |
| write_test         | test_written  | Ready     | PR link                                                   |
| write_and_run_test | test_passed   | Ready     | PR link                                                   |
| write_and_run_test | bug_found     | Failed    | failing test, expected vs actual, output excerpt,         |
|                    |               |           | diagnosis (cause, file, line), command to reproduce, PR   |
| any                | job_error     | stays put | "Job did not finish" with the reason, and how to retry    |

Failed means only that the product code is buggy. Anything else that stops a job is a `job_error`, which leaves the
work item where it is.

Everything in a result was written by a coding agent that read work-item text, so none of it is trusted: every field
is validated here, escaped into the comment, and output goes in code blocks. The comment then goes through the same
HTML sanitiser and serializer as a comment posted to the public API, and the state change through the same
serializer and activity task as a public-API work item update, both as the workspace's "Coding agent" bot.
"""

import html
import json
from collections.abc import Callable
from dataclasses import dataclass

from crum import impersonate
from django.core.serializers.json import DjangoJSONEncoder
from django.core.validators import URLValidator
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from plane.api.serializers import IssueCommentCreateSerializer, IssueCommentSerializer, IssueSerializer
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.webhook_task import model_activity
from plane.coding.bot import coding_bot
from plane.coding.columns import Column, resolve_column
from plane.coding.exceptions import Conflict, InvalidResult
from plane.coding.serializers.base import StrictSerializer
from plane.coding.models import CodingAction, CodingJob, JobOutcome, JobStatus, ProjectCodingSettings
from plane.db.models import Issue, IssueComment
from plane.utils.content_validator import validate_html_content
from plane.utils.host import base_host

__all__ = ["ALLOWED_OUTCOMES", "OUTCOME_COLUMN", "Applied", "apply_result", "validate_result"]

ALLOWED_OUTCOMES = {
    CodingAction.FIX_BUG: (JobOutcome.FIXED, JobOutcome.COULD_NOT_FIX, JobOutcome.JOB_ERROR),
    CodingAction.WRITE_TEST: (JobOutcome.TEST_WRITTEN, JobOutcome.JOB_ERROR),
    CodingAction.WRITE_AND_RUN_TEST: (JobOutcome.TEST_PASSED, JobOutcome.BUG_FOUND, JobOutcome.JOB_ERROR),
}

# Outcomes not listed leave the work item where it is.
OUTCOME_COLUMN = {
    JobOutcome.FIXED: Column.IN_REVIEW,
    JobOutcome.TEST_WRITTEN: Column.READY,
    JobOutcome.TEST_PASSED: Column.READY,
    JobOutcome.BUG_FOUND: Column.FAILED,
}

SHORT = 2000
LONG = 20000


# --------------------------------------------------------------------------- validation


class _HttpsUrlField(serializers.CharField):
    """An absolute https URL: the comment links to it, so no other scheme."""

    def __init__(self, **kwargs):
        super().__init__(max_length=SHORT, validators=[URLValidator(schemes=["https"])], **kwargs)


# Until jobs can push and open pull requests (Step 5 of the build plan adds repository access), a job that changed
# code reports no `pr_url`; the changes stay in the job's folder on the machine, and the machine lists the changed
# files. `pr_url` is therefore optional everywhere for now.
_PR_URL = {"required": False}
CHANGED_FILES_MAX = 200


def _changed_files():
    return serializers.ListField(
        child=serializers.CharField(max_length=500), max_length=CHANGED_FILES_MAX, required=False
    )


class _Diagnosis(StrictSerializer):
    likely_cause = serializers.CharField(max_length=SHORT)
    file = serializers.CharField(max_length=500, required=False, allow_blank=True)
    line = serializers.IntegerField(min_value=1, required=False)


class _Result(StrictSerializer):
    outcome = serializers.ChoiceField(choices=JobOutcome.choices)


class _Fixed(_Result):
    summary = serializers.CharField(max_length=LONG)
    pr_url = _HttpsUrlField(**_PR_URL)
    changed_files = _changed_files()


class _CouldNotFix(_Result):
    attempted = serializers.CharField(max_length=LONG)
    reason = serializers.CharField(max_length=LONG)


class _TestWritten(_Result):
    pr_url = _HttpsUrlField(**_PR_URL)
    changed_files = _changed_files()
    test_name = serializers.CharField(max_length=SHORT, required=False, allow_blank=True)
    summary = serializers.CharField(max_length=LONG, required=False, allow_blank=True)


class _TestPassed(_TestWritten):
    pass


class _BugFound(_Result):
    test_name = serializers.CharField(max_length=SHORT)
    expected = serializers.CharField(max_length=LONG, trim_whitespace=False)
    actual = serializers.CharField(max_length=LONG, trim_whitespace=False)
    output = serializers.CharField(max_length=LONG, trim_whitespace=False)
    diagnosis = _Diagnosis()
    reproduce = serializers.CharField(max_length=SHORT, trim_whitespace=False)
    pr_url = _HttpsUrlField(**_PR_URL)
    changed_files = _changed_files()


class _JobError(_Result):
    reason = serializers.CharField(max_length=SHORT)


_SCHEMAS = {
    JobOutcome.FIXED: _Fixed,
    JobOutcome.COULD_NOT_FIX: _CouldNotFix,
    JobOutcome.TEST_WRITTEN: _TestWritten,
    JobOutcome.TEST_PASSED: _TestPassed,
    JobOutcome.BUG_FOUND: _BugFound,
    JobOutcome.JOB_ERROR: _JobError,
}


def validate_result(action: str, result) -> dict:
    """The result as a plain dict once it matches its outcome's schema and the outcome fits `action`.

    Raises `InvalidResult` naming each wrong field.
    """
    if not isinstance(result, dict):
        raise InvalidResult({"non_field_errors": ["The result must be a JSON object."]})
    outcome = result.get("outcome")
    allowed = ALLOWED_OUTCOMES[CodingAction(action)]
    if outcome not in allowed:
        raise InvalidResult({"outcome": [f"Must be one of {', '.join(allowed)} for a {action} job."]})
    schema = _SCHEMAS[JobOutcome(outcome)](data=result)
    if not schema.is_valid():
        raise InvalidResult(schema.errors)
    return json.loads(json.dumps(schema.validated_data, cls=DjangoJSONEncoder))


# --------------------------------------------------------------------------- the comment


def _text(value: str) -> str:
    return html.escape(value).replace("\n", "<br>")


def _code(value: str) -> str:
    return f"<code>{html.escape(value)}</code>"


def _block(value: str) -> str:
    return f"<pre><code>{html.escape(value)}</code></pre>"


def _link(url: str) -> str:
    href = html.escape(url, quote=True)
    return f'<a href="{href}" target="_blank" rel="noopener noreferrer nofollow">{html.escape(url)}</a>'


def _p(*parts: str) -> str:
    return f"<p>{''.join(parts)}</p>"


def user_name(user) -> str:
    """How a comment names a person: never their email address."""
    if user is None:
        return "a former member"
    full_name = f"{user.first_name} {user.last_name}".strip()
    return user.display_name or full_name or "a member"


def _where(column: Column | None, state, moved: bool, archived: bool = False) -> str:
    if column is None:
        return "The work item stays where it is."
    if archived:
        return f"The work item was archived during the job, so it was not moved to {column.label}."
    if state is None:
        return (
            f"This project has no {column.label} column, so the work item was not moved. "
            "A project admin can choose one in the project's coding settings."
        )
    if moved:
        return f"Moved to {state.name}."
    return f"It is already in {state.name}."


CHANGED_FILES_SHOWN = 20
CODE_OUTCOMES = (JobOutcome.FIXED, JobOutcome.TEST_WRITTEN, JobOutcome.TEST_PASSED, JobOutcome.BUG_FOUND)


def build_comment(
    job: CodingJob, data: dict, column: Column | None, state, moved: bool, archived: bool = False
) -> str:
    """The comment's HTML. Every agent-written value is escaped; output and commands are code blocks."""
    agent = job.get_agent_display()
    machine = f" on {html.escape(job.ran_on_name)}" if job.ran_on_name else ""
    parts = [
        _p(
            f"<strong>{html.escape(job.get_action_display())}</strong> with {html.escape(agent)}{machine}, "
            f"requested by {html.escape(user_name(job.requested_by))}."
        )
    ]
    where = html.escape(_where(column, state, moved, archived))
    outcome = data["outcome"]
    if outcome == JobOutcome.FIXED:
        parts += [_p("<strong>Fixed.</strong> ", where), _p(_text(data["summary"]))]
    elif outcome == JobOutcome.COULD_NOT_FIX:
        parts += [
            _p("<strong>Could not fix.</strong> ", where),
            _p("<strong>What was tried:</strong> ", _text(data["attempted"])),
            _p("<strong>Why it stopped:</strong> ", _text(data["reason"])),
        ]
    elif outcome == JobOutcome.TEST_WRITTEN:
        parts.append(_p("<strong>Test written</strong> (not run). ", where))
    elif outcome == JobOutcome.TEST_PASSED:
        parts.append(_p("<strong>Test passes.</strong> ", where))
    elif outcome == JobOutcome.BUG_FOUND:
        diagnosis = data["diagnosis"]
        location = diagnosis.get("file", "")
        if location and diagnosis.get("line"):
            location = f"{location}:{diagnosis['line']}"
        parts += [
            _p("<strong>The test fails because the product code is buggy.</strong> ", where),
            _p("<strong>Failing test:</strong> ", _code(data["test_name"])),
            _p("<strong>Expected:</strong>"),
            _block(data["expected"]),
            _p("<strong>Actual:</strong>"),
            _block(data["actual"]),
            _p("<strong>Output excerpt:</strong>"),
            _block(data["output"]),
            _p(
                "<strong>Likely cause:</strong> ",
                _text(diagnosis["likely_cause"]),
                f" ({_code(location)})" if location else "",
            ),
            _p("<strong>Reproduce with:</strong>"),
            _block(data["reproduce"]),
        ]
    else:  # job_error
        parts += [
            _p("<strong>Job did not finish:</strong> ", _text(data["reason"])),
            _p(where, f" Retry it from the work item's coding jobs (job {_code(str(job.id))})."),
        ]
    if data.get("test_name") and outcome in (JobOutcome.TEST_WRITTEN, JobOutcome.TEST_PASSED):
        parts.append(_p("<strong>Test:</strong> ", _code(data["test_name"])))
    if data.get("summary") and outcome in (JobOutcome.TEST_WRITTEN, JobOutcome.TEST_PASSED):
        parts.append(_p(_text(data["summary"])))
    if data.get("pr_url"):
        parts.append(_p("<strong>Pull request:</strong> ", _link(data["pr_url"])))
    elif outcome in CODE_OUTCOMES:
        where_kept = f" on {html.escape(job.ran_on_name)}" if job.ran_on_name else " on the machine"
        parts.append(
            _p(
                "No pull request: jobs cannot push to the repository yet, so the changes stay in the job's folder",
                f"{where_kept} (job {_code(str(job.id))}).",
            )
        )
    files = data.get("changed_files") or []
    if files and outcome in CODE_OUTCOMES:
        shown = "".join(f"<li>{_code(name)}</li>" for name in files[:CHANGED_FILES_SHOWN])
        more = len(files) - CHANGED_FILES_SHOWN
        parts.append(_p("<strong>Changed files:</strong>"))
        parts.append(f"<ul>{shown}</ul>")
        if more > 0:
            parts.append(_p(f"and {more} more."))
    return "".join(parts)


# --------------------------------------------------------------------------- applying


def _origin() -> str:
    """The web app's address, which the activity and webhook tasks use for links. A result may arrive with no request
    (from a worker), so it is never taken from one."""
    return base_host(request=None, is_app=True)


@dataclass
class Applied:
    job: CodingJob
    # False when this exact result had already been applied, so nothing changed.
    changed: bool


def _move(issue: Issue, state, bot, slug: str) -> Callable[[], None]:
    """Set the work item's state the way the public API's PATCH does; returns what to queue after commit."""
    current_instance = json.dumps(IssueSerializer(issue).data, cls=DjangoJSONEncoder)
    serializer = IssueSerializer(
        issue,
        data={"state": str(state.id)},
        context={"project_id": issue.project_id, "workspace_id": issue.workspace_id},
        partial=True,
    )
    serializer.is_valid(raise_exception=True)
    serializer.save()
    requested = {"state": str(state.id)}

    def queue():
        issue_activity.delay(
            type="issue.activity.updated",
            requested_data=json.dumps(requested, cls=DjangoJSONEncoder),
            actor_id=str(bot.id),
            issue_id=str(issue.id),
            project_id=str(issue.project_id),
            current_instance=current_instance,
            epoch=int(timezone.now().timestamp()),
            notification=True,
            # The bot follows nothing it moves; and without an origin the email notifications are skipped.
            subscriber=False,
            origin=_origin(),
        )
        model_activity.delay(
            model_name="issue",
            model_id=str(issue.id),
            requested_data=requested,
            current_instance=current_instance,
            actor_id=bot.id,
            slug=slug,
            origin=_origin(),
        )

    return queue


def _comment(issue: Issue, comment_html: str, bot, slug: str):
    """Post the comment the way the public API's comment POST does; returns `(comment, what to queue)`."""
    is_valid, error, sanitized = validate_html_content(comment_html)
    if not is_valid:
        raise ValueError(error)
    data = {"comment_html": sanitized or comment_html, "access": "INTERNAL"}
    serializer = IssueCommentCreateSerializer(data=data)
    serializer.is_valid(raise_exception=True)
    serializer.save(project_id=issue.project_id, issue_id=issue.id, actor=bot)
    comment = IssueComment.objects.get(pk=serializer.instance.id)
    created = IssueCommentSerializer(comment).data

    def queue():
        issue_activity.delay(
            type="comment.activity.created",
            requested_data=json.dumps(created, cls=DjangoJSONEncoder),
            actor_id=str(bot.id),
            issue_id=str(issue.id),
            project_id=str(issue.project_id),
            current_instance=None,
            epoch=int(timezone.now().timestamp()),
            # Unlike a public-API comment, this one tells the work item's subscribers (the requester among them).
            notification=True,
            subscriber=False,
            origin=_origin(),
        )
        model_activity.delay(
            model_name="issue_comment",
            model_id=str(comment.id),
            requested_data=data,
            current_instance=None,
            actor_id=bot.id,
            slug=slug,
            origin=_origin(),
        )

    return comment, queue


def apply_result(job: CodingJob, result, *, status: str = JobStatus.FINISHED) -> Applied:
    """Validate `result`, move the work item per the outcomes table, comment on it, and finish the job.

    Idempotent: applying the result a job already has changes nothing and returns `changed=False`. A different
    result for a job that already has one raises `Conflict` (`RESULT_ALREADY_APPLIED`), as does a result for a job
    that ended without one. `status` is `cancelled` only for `plane.coding.services.cancel_job`.
    """
    data = validate_result(job.action, result)
    with transaction.atomic():
        job = (
            CodingJob.objects.select_related("issue", "workspace", "requested_by")
            .select_for_update(of=("self",))
            .get(pk=job.pk)
        )
        if job.outcome is not None:
            if job.result == data:
                return Applied(job, changed=False)
            raise Conflict("This job already has a different result.", code="RESULT_ALREADY_APPLIED")
        if not job.is_active:
            raise Conflict("This job has ended.", code="JOB_NOT_ACTIVE")

        # `all_objects`: a work item archived or deleted during the job still gets its job finished.
        issue = Issue.all_objects.select_for_update().get(pk=job.issue_id)
        slug = job.workspace.slug
        bot = coding_bot(job.workspace)
        outcome = JobOutcome(data["outcome"])
        column = OUTCOME_COLUMN.get(outcome)
        coding_settings = ProjectCodingSettings.objects.filter(project_id=job.project_id).first()
        # Archived (or turned back into a draft or intake item) during the job: the outcome is still recorded and
        # commented, but the work item is not moved, since moving it would bring it back onto the board.
        archived = issue.deleted_at is None and not Issue.issue_objects.filter(pk=issue.pk).exists()
        state = resolve_column(job.project_id, coding_settings, column)[0] if column and not archived else None
        moved = state is not None and issue.state_id != state.id
        queued = []
        comment = None
        # As the bot, so the rows it saves are attributed to it rather than to whoever made this request.
        with impersonate(bot):
            if moved:
                queued.append(_move(issue, state, bot, slug))
            # A deleted work item gets no comment; the job still ends with its outcome.
            if issue.deleted_at is None:
                comment, queue_comment = _comment(
                    issue, build_comment(job, data, column, state, moved, archived), bot, slug
                )
                queued.append(queue_comment)

            job.outcome = outcome
            job.result = data
            job.pr_url = data.get("pr_url", "")
            job.error_reason = data["reason"] if outcome == JobOutcome.JOB_ERROR else ""
            job.status = status
            job.finished_at = timezone.now()
            job.comment = comment
            job.save()
        for queue in queued:
            transaction.on_commit(queue)
    return Applied(job, changed=True)
