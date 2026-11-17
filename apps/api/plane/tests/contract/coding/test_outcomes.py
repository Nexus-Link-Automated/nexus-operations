# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""`plane.coding.outcomes.apply_result`: one test per row of the outcomes table, then validation, idempotency,
escaping of agent-written text, and how the change and the comment are recorded."""

from html.parser import HTMLParser

import pytest

from plane.bgtasks.issue_activities_task import issue_activity
from plane.coding.bot import BotUnavailable
from plane.coding.exceptions import Conflict, InvalidResult
from plane.coding.models import CodingJob, JobOutcome, JobStatus, ProjectCodingSettings
from plane.coding.outcomes import apply_result
from plane.db.models import IssueActivity, IssueComment, User, WorkspaceMember

from .conftest import make_state


def _tags(html: str) -> list:
    """Every start tag in `html` with its attributes."""

    class Collector(HTMLParser):
        def __init__(self):
            super().__init__()
            self.tags = []

        def handle_starttag(self, tag, attrs):
            self.tags.append((tag, attrs))

    collector = Collector()
    collector.feed(html)
    return collector.tags


PR = "https://github.com/example/app/pull/7"

FIXED = {"outcome": "fixed", "summary": "Null check on the session token.", "pr_url": PR}
COULD_NOT_FIX = {
    "outcome": "could_not_fix",
    "attempted": "Reproduced the crash and traced it to the auth client.",
    "reason": "The fix needs a schema change the job may not make.",
}
TEST_WRITTEN = {"outcome": "test_written", "pr_url": PR, "test_name": "test_login_with_expired_token"}
TEST_PASSED = {"outcome": "test_passed", "pr_url": PR, "test_name": "test_login_with_expired_token"}
BUG_FOUND = {
    "outcome": "bug_found",
    "test_name": "test_login_with_expired_token",
    "expected": "401 Unauthorized",
    "actual": "500 Internal Server Error",
    "output": "Traceback (most recent call last):\n  File \"auth.py\", line 42\nKeyError: 'exp'",
    "diagnosis": {"likely_cause": "The token's expiry is read without a default.", "file": "auth.py", "line": 42},
    "reproduce": "pytest tests/test_auth.py -k expired",
    "pr_url": PR,
}
JOB_ERROR = {"outcome": "job_error", "reason": "The machine went offline."}


@pytest.fixture
def make_job(issue, create_user):
    def make(action, agent="codex", user=None):
        return CodingJob.objects.create(issue=issue, action=action, agent=agent, requested_by=user or create_user)

    return make


def apply(tasks, job, result, **kwargs):
    with tasks.commit():
        return apply_result(job, result, **kwargs)


def comment_of(job) -> str:
    job.refresh_from_db()
    return IssueComment.objects.get(pk=job.comment_id).comment_html


@pytest.mark.contract
class TestOutcomeRows:
    def test_fix_bug_fixed_moves_to_in_review(self, tasks, make_job, issue, states, create_user):
        create_user.display_name = "Ada"
        create_user.save()
        job = make_job("fix_bug")
        applied = apply(tasks, job, FIXED)
        assert applied.changed
        issue.refresh_from_db()
        assert issue.state == states["in review"]
        html = comment_of(job)
        assert "Fixed." in html and "Moved to In Review." in html
        assert "Null check on the session token." in html and f'href="{PR}"' in html
        assert "Fix bug</strong> with Codex, requested by Ada." in html
        job.refresh_from_db()
        assert (job.status, job.outcome, job.pr_url) == (JobStatus.FINISHED, JobOutcome.FIXED, PR)
        assert job.finished_at is not None and job.result == FIXED

    def test_fix_bug_could_not_fix_stays_put(self, tasks, make_job, issue, states):
        job = make_job("fix_bug")
        apply(tasks, job, COULD_NOT_FIX)
        issue.refresh_from_db()
        assert issue.state == states["todo"]
        html = comment_of(job)
        assert "Could not fix." in html and "The work item stays where it is." in html
        assert "What was tried:</strong> Reproduced the crash" in html
        assert "Why it stopped:</strong> The fix needs a schema change" in html
        assert tasks.activity_types() == ["comment.activity.created"]

    def test_write_test_written_moves_to_ready(self, tasks, make_job, issue, states):
        job = make_job("write_test")
        apply(tasks, job, TEST_WRITTEN)
        issue.refresh_from_db()
        assert issue.state == states["ready"]
        html = comment_of(job)
        assert "Test written</strong> (not run). Moved to ready." in html and f'href="{PR}"' in html

    def test_write_and_run_test_passed_moves_to_ready(self, tasks, make_job, issue, states):
        job = make_job("write_and_run_test")
        apply(tasks, job, TEST_PASSED)
        issue.refresh_from_db()
        assert issue.state == states["ready"]
        html = comment_of(job)
        assert "Test passes." in html and f'href="{PR}"' in html

    def test_write_and_run_test_bug_found_moves_to_failed(self, tasks, make_job, issue, states):
        job = make_job("write_and_run_test", agent="claude")
        apply(tasks, job, BUG_FOUND)
        issue.refresh_from_db()
        assert issue.state == states["failed"]
        html = comment_of(job)
        assert "product code is buggy" in html and "Moved to Failed." in html and "with Claude" in html
        assert "Failing test:</strong> <code>test_login_with_expired_token</code>" in html
        assert "<pre><code>401 Unauthorized</code></pre>" in html
        assert "<pre><code>500 Internal Server Error</code></pre>" in html
        assert "KeyError: &#x27;exp&#x27;</code></pre>" in html or "KeyError: 'exp'</code></pre>" in html
        assert "The token's expiry is read without a default." in html or "The token&#x27;s expiry" in html
        assert "<code>auth.py:42</code>" in html
        assert "<pre><code>pytest tests/test_auth.py -k expired</code></pre>" in html
        assert f'href="{PR}"' in html

    @pytest.mark.parametrize("action", ["fix_bug", "write_test", "write_and_run_test"])
    def test_job_error_stays_put_with_retry(self, tasks, make_job, issue, states, action):
        job = make_job(action)
        apply(tasks, job, JOB_ERROR)
        issue.refresh_from_db()
        assert issue.state == states["todo"]
        html = comment_of(job)
        assert "Job did not finish:</strong> The machine went offline." in html
        assert "The work item stays where it is." in html and "Retry it" in html and str(job.id) in html
        job.refresh_from_db()
        assert job.error_reason == "The machine went offline." and job.is_retryable


@pytest.mark.contract
class TestColumns:
    def test_no_column_leaves_the_item_and_says_so(self, tasks, make_job, issue, states):
        states["in review"].delete()
        job = make_job("fix_bug")
        apply(tasks, job, FIXED)
        issue.refresh_from_db()
        assert issue.state == states["todo"]
        html = comment_of(job)
        assert "This project has no In review column, so the work item was not moved." in html
        assert "issue.activity.updated" not in tasks.activity_types()

    def test_chosen_state_wins_over_the_name(self, tasks, make_job, project, issue, states):
        shipped = make_state(project, "Shipped")
        ProjectCodingSettings.objects.create(
            project=project, enabled=True, repo_url="https://x.test/r", ready_state=shipped
        )
        job = make_job("write_test")
        apply(tasks, job, TEST_WRITTEN)
        issue.refresh_from_db()
        assert issue.state == shipped

    def test_already_there_is_not_a_move(self, tasks, make_job, issue, states):
        issue.state = states["ready"]
        issue.save()
        job = make_job("write_test")
        apply(tasks, job, TEST_WRITTEN)
        assert "It is already in ready." in comment_of(job)
        assert tasks.activity_types() == ["comment.activity.created"]


@pytest.mark.contract
class TestRecording:
    def test_state_change_and_comment_are_recorded_as_the_bot(self, tasks, make_job, issue, states, workspace):
        job = make_job("fix_bug")
        apply(tasks, job, FIXED)
        bot = User.objects.get(is_bot=True, bot_type="coding_agent", username=f"coding_agent_{workspace.id.hex}")
        assert bot.display_name == "Coding agent"
        assert not WorkspaceMember.objects.filter(member=bot).exists()

        comment = IssueComment.objects.get(pk=CodingJob.objects.get(pk=job.pk).comment_id)
        assert comment.actor == bot and comment.created_by == bot and comment.access == "INTERNAL"
        issue.refresh_from_db()
        assert issue.updated_by == bot

        assert tasks.activity_types() == ["issue.activity.updated", "comment.activity.created"]
        for call in tasks.issue_activity.delay.call_args_list:
            assert call.kwargs["actor_id"] == str(bot.id)
        # Run the queued activity task as the worker would: it records the state change from Todo to In Review.
        state_call = tasks.issue_activity.delay.call_args_list[0]
        issue_activity(**{**state_call.kwargs, "notification": False, "origin": None})
        activity = IssueActivity.objects.get(issue=issue, field="state")
        assert (activity.old_value, activity.new_value, activity.actor) == ("Todo", "In Review", bot)
        assert [c.kwargs["model_name"] for c in tasks.model_activity.delay.call_args_list] == ["issue", "issue_comment"]
        # Notifications go out (emails need the origin) and the bot subscribes to nothing.
        for call in tasks.issue_activity.delay.call_args_list:
            assert call.kwargs["notification"] is True and call.kwargs["subscriber"] is False
            assert call.kwargs["origin"]
        assert all(c.kwargs["origin"] for c in tasks.model_activity.delay.call_args_list)
        assert bot.email.endswith("@coding-agent.invalid")

    def test_one_bot_per_workspace(self, tasks, make_job, issue, project, other_workspace):
        apply(tasks, make_job("fix_bug"), JOB_ERROR)
        apply(tasks, make_job("write_test"), JOB_ERROR)
        apply(tasks, other_workspace["job"], JOB_ERROR)
        assert User.objects.filter(bot_type="coding_agent").count() == 2

    def test_a_taken_username_is_never_used_as_the_bot(self, tasks, make_job, workspace):
        User.objects.create(username=f"coding_agent_{workspace.id.hex}", email="someone@example.com")
        with pytest.raises(BotUnavailable):
            apply(tasks, make_job("fix_bug"), JOB_ERROR)

    def test_nothing_is_queued_when_the_transaction_rolls_back(self, tasks, make_job):
        job = make_job("fix_bug")
        apply_result(job, FIXED)  # outside tasks.commit(): the test's transaction never commits
        assert tasks.issue_activity.delay.call_count == 0


@pytest.mark.contract
class TestIdempotency:
    def test_same_result_twice_changes_nothing(self, tasks, make_job, issue, states):
        job = make_job("fix_bug")
        apply(tasks, job, FIXED)
        issue.state = states["todo"]  # someone moved it back by hand
        issue.save()
        again = apply(tasks, job, dict(FIXED))
        assert not again.changed
        assert IssueComment.objects.filter(issue=issue).count() == 1
        issue.refresh_from_db()
        assert issue.state == states["todo"]
        assert tasks.activity_types() == ["issue.activity.updated", "comment.activity.created"]

    def test_a_different_result_afterwards_is_refused(self, tasks, make_job, issue):
        job = make_job("fix_bug")
        apply(tasks, job, FIXED)
        with pytest.raises(Conflict) as exc:
            apply(tasks, job, COULD_NOT_FIX)
        assert exc.value.code == "RESULT_ALREADY_APPLIED"
        assert IssueComment.objects.filter(issue=issue).count() == 1

    def test_a_cancelled_job_takes_no_result(self, tasks, make_job):
        job = make_job("fix_bug")
        apply(tasks, job, {"outcome": "job_error", "reason": "Cancelled."}, status=JobStatus.CANCELLED)
        with pytest.raises(Conflict):
            apply(tasks, job, FIXED)


@pytest.mark.contract
class TestValidation:
    @pytest.mark.parametrize(
        "action,result,field",
        [
            ("fix_bug", TEST_PASSED, "outcome"),
            ("write_test", FIXED, "outcome"),
            ("write_test", BUG_FOUND, "outcome"),
            ("write_and_run_test", {"outcome": "nope"}, "outcome"),
            ("fix_bug", {"outcome": "fixed", "pr_url": PR}, "summary"),
            ("fix_bug", {**FIXED, "pr_url": "http://github.com/x/y/pull/1"}, "pr_url"),
            ("fix_bug", {**FIXED, "pr_url": "javascript:alert(1)"}, "pr_url"),
            ("fix_bug", {**FIXED, "extra": "x"}, "extra"),
            ("write_and_run_test", {**BUG_FOUND, "diagnosis": {"file": "a.py"}}, "diagnosis"),
            ("write_and_run_test", {**BUG_FOUND, "diagnosis": {"likely_cause": "x", "line": 0}}, "diagnosis"),
            ("write_and_run_test", {k: v for k, v in BUG_FOUND.items() if k != "reproduce"}, "reproduce"),
            ("fix_bug", {"outcome": "job_error"}, "reason"),
            ("fix_bug", {**JOB_ERROR, "reason": "x" * 2001}, "reason"),
        ],
    )
    def test_invalid_results_are_refused_and_change_nothing(self, tasks, make_job, issue, action, result, field):
        job = make_job(action)
        with pytest.raises(InvalidResult) as exc:
            apply(tasks, job, result)
        assert field in exc.value.errors
        job.refresh_from_db()
        assert job.status == JobStatus.QUEUED and job.outcome is None
        assert not IssueComment.objects.filter(issue=issue).exists()

    def test_not_an_object(self, tasks, make_job):
        with pytest.raises(InvalidResult):
            apply(tasks, make_job("fix_bug"), ["fixed"])


@pytest.mark.contract
class TestEscaping:
    def test_agent_text_cannot_inject_markup(self, tasks, make_job, issue, create_user):
        create_user.display_name = "<b>Eve</b>"
        create_user.save()
        hostile = '<script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:x()">click</a>'
        result = {
            **BUG_FOUND,
            "test_name": hostile,
            "expected": "</code></pre><script>alert(3)</script>",
            "actual": hostile,
            "output": hostile,
            "diagnosis": {"likely_cause": hostile, "file": '"><svg onload=alert(4)>', "line": 1},
            "reproduce": hostile,
        }
        job = make_job("write_and_run_test")
        apply(tasks, job, result)
        html = comment_of(job)
        tags = _tags(html)
        assert {tag for tag, _ in tags} <= {"p", "strong", "code", "pre", "br", "a"}
        assert [dict(attrs).get("href") for tag, attrs in tags if tag == "a"] == [PR]
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
        assert "&lt;b&gt;Eve&lt;/b&gt;" in html
        # Output and commands stay inside their code blocks.
        assert "<pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(3)&lt;/script&gt;</code></pre>" in html
        assert html.count("<pre><code>") == 4

    def test_summary_newlines_become_line_breaks(self, tasks, make_job):
        job = make_job("fix_bug")
        apply(tasks, job, {**FIXED, "summary": "first\n<i>second</i>"})
        assert "first<br>&lt;i&gt;second&lt;/i&gt;" in comment_of(job)
