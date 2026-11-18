# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Repository access and pull requests: the CRM pushes each job's changes to a branch of its own with a short-lived
token for the one repository, opens the pull request, and puts its link in the outcome. Checked against a fake GitHub
(`fake_github.py`)."""

import base64
from datetime import timedelta
from unittest import mock

import pytest
from django.core.cache import cache
from django.utils import timezone

from plane.coding import github, publish
from plane.coding.dispatch import expire_jobs
from plane.coding.models import CodingJob, CodingJobChanges, JobOutcome, JobStatus, ProjectCodingSettings
from plane.coding.services import cancel_job
from plane.db.models import IssueComment

from .fake_github import APP_ID, FakeGitHub, make_key
from .test_dispatch import CLAUDE_READY, READY, _reset_machine_throttles, beat, machine_client, report, run_on  # noqa: F401

BASE = "a" * 40
FIXED = {"outcome": "fixed", "summary": "Null check added.", "changed_files": ["app/auth.py"]}
BUG_FOUND = {
    "outcome": "bug_found",
    "test_name": "test_expired_login",
    "expected": "401",
    "actual": "500",
    "output": "KeyError: 'exp'",
    "diagnosis": {"likely_cause": "No default for exp.", "file": "app/auth.py", "line": 42},
    "reproduce": "pytest -k expired",
    "changed_files": ["tests/test_auth.py"],
}


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


CHANGES = {
    "base_commit": BASE,
    "files": [
        {"path": "app/auth.py", "mode": "100644", "content": b64("def login():\n    return 401\n")},
        {"path": "scripts/run.sh", "mode": "100755", "content": b64("#!/bin/sh\n")},
        {"path": "old.txt", "deleted": True},
    ],
}


def send(key, job_id, result, changes=CHANGES):
    body = {"result": result}
    if changes is not None:
        body["changes"] = changes
    return machine_client(key).post(f"/api/v1/coding-machines/jobs/{job_id}/result/", body, format="json")


@pytest.fixture(autouse=True)
def _clear_github_cache():
    cache.delete_pattern("coding:github:*")
    cache.delete_pattern("coding_machine_*")
    yield
    cache.delete_pattern("coding:github:*")


@pytest.fixture
def fake(settings):
    pem, public = make_key()
    settings.GITHUB_APP_ID = APP_ID
    settings.GITHUB_APP_PRIVATE_KEY = pem
    settings.GITHUB_APP_SLUG = "nexus-coding"
    settings.GITHUB_API_URL = "https://api.github.com"
    settings.GITHUB_WEB_URL = "https://github.com"
    gh = FakeGitHub(public)
    gh.add_repo("example", "app")
    with mock.patch.object(github, "_transport", gh.transport):
        yield gh


@pytest.fixture
def publish_now():
    """Runs the publish task as soon as it is queued (on commit), instead of on a Celery worker."""
    from plane.coding import tasks as coding_tasks

    with mock.patch.object(coding_tasks.publish_coding_job, "delay", side_effect=publish.publish_job) as delay:
        yield delay


@pytest.fixture
def running(member, make_machine, start):
    """A fix_bug job running on the member's machine: (job, key)."""

    def make(action="fix_bug", agents=(READY,)):
        _, key = make_machine(member[0], name=f"Laptop {action}")
        job = start(member[0], action=action, agent=agents[0]["id"])
        run_on(key, job, agents=agents)
        return job, key

    return make


@pytest.mark.contract
class TestTokens:
    def test_push_token_is_for_one_repository_and_only_what_the_push_needs(self, fake):
        token = github.repo_token(github.parse_repo("https://github.com/example/app"), github.PUSH_PERMISSIONS)
        (call,) = fake.calls("POST", r"/access_tokens$")
        assert call[2] == {"repositories": ["app"], "permissions": {"contents": "write", "pull_requests": "write"}}
        assert fake.tokens[token.token] == {
            "repo": "example/app",
            "permissions": {"contents": "write", "pull_requests": "write"},
        }
        # Never printed.
        assert token.token not in repr(token)

    def test_a_token_granting_more_than_asked_is_refused(self, fake):
        fake.grant_extra = True
        with pytest.raises(github.GitHubError, match="more permissions"):
            github.repo_token(github.parse_repo("https://github.com/example/app"), github.PUSH_PERMISSIONS)

    def test_app_jwt_is_short_lived(self, fake):
        github.installation_id(github.parse_repo("https://github.com/example/app"))
        import jwt as pyjwt

        (call,) = fake.calls("GET", r"/installation$")
        claims = pyjwt.decode(call[3], fake.public_key, algorithms=["RS256"])
        assert claims["iss"] == APP_ID and claims["exp"] - claims["iat"] <= 600

    @pytest.mark.parametrize(
        "url,expected",
        [
            ("https://github.com/example/app", "example/app"),
            ("https://github.com/example/app.git", "example/app"),
            ("https://github.com/example/app/", "example/app"),
            ("http://github.com/example/app", None),
            ("https://gitlab.com/example/app", None),
            ("https://x@github.com/example/app", None),
            ("https://github.com/example", None),
            ("https://github.com/example/app/tree/main", None),
            ("https://github.com/../app", None),
        ],
    )
    def test_parse_repo(self, url, expected):
        repo = github.parse_repo(url)
        assert (repo.full_name if repo else None) == expected


@pytest.mark.contract
class TestPullRequest:
    def test_fix_bug_opens_a_pull_request_and_links_it(
        self, fake, publish_now, running, tasks, issue, states, coding_settings
    ):
        job, key = running()
        with tasks.commit():
            res = send(key, job.id, FIXED)
        assert res.status_code == 200, res.data
        assert res.json()["changed"] is True
        job.refresh_from_db()
        branch = f"nexus/fix-bug/{job.id.hex[:8]}"
        assert (job.status, job.outcome) == (JobStatus.FINISHED, JobOutcome.FIXED)
        assert job.pr_url == "https://github.com/example/app/pull/1" and job.pr_branch == branch
        assert job.result["pr_url"] == job.pr_url
        issue.refresh_from_db()
        assert issue.state_id == states["in review"].id
        html = IssueComment.objects.get(issue=issue).comment_html
        assert 'href="https://github.com/example/app/pull/1"' in html and branch in html
        assert "No pull request" not in html
        # The commit sits on the job's starting commit; the branch is created, never updated.
        (commit,) = fake.calls("POST", r"/git/commits$")
        assert commit[2]["parents"] == [BASE]
        (tree,) = fake.calls("POST", r"/git/trees$")
        assert tree[2]["base_tree"] == "t" * 40
        assert {e["path"]: e["mode"] for e in tree[2]["tree"]} == {
            "app/auth.py": "100644",
            "scripts/run.sh": "100755",
            "old.txt": "100644",
        }
        assert [e["sha"] for e in tree[2]["tree"] if e["path"] == "old.txt"] == [None]
        (ref,) = fake.calls("POST", r"/git/refs$")
        assert ref[2]["ref"] == f"refs/heads/{branch}"
        assert not fake.calls("PATCH") and not fake.calls("PUT")
        assert fake.repos["example/app"].refs["refs/heads/main"] == BASE
        (pull,) = fake.pulls
        assert pull["head"] == branch and pull["base"] == "main" and pull["draft"] is False
        # The changes are not kept once the pull request is open.
        assert not CodingJobChanges.objects.exists()

    def test_bug_found_opens_a_draft_with_the_failing_test(
        self, fake, publish_now, running, tasks, issue, states, coding_settings
    ):
        job, key = running("write_and_run_test")
        with tasks.commit():
            assert send(key, job.id, BUG_FOUND).status_code == 200
        job.refresh_from_db()
        assert job.outcome == JobOutcome.BUG_FOUND and job.pr_url.endswith("/pull/1")
        assert job.pr_branch.startswith("nexus/write-and-run-test/")
        (pull,) = fake.pulls
        assert pull["draft"] is True and pull["title"].startswith("APP-") and "Failing test:" in pull["title"]
        assert "test_expired_login" in pull["body"]
        issue.refresh_from_db()
        assert issue.state_id == states["failed"].id

    def test_draft_falls_back_when_the_repository_has_no_drafts(
        self, fake, publish_now, running, tasks, coding_settings
    ):
        fake.no_draft = True
        job, key = running("write_and_run_test")
        with tasks.commit():
            send(key, job.id, BUG_FOUND)
        job.refresh_from_db()
        assert job.pr_url and [p["draft"] for p in fake.pulls] == [False]

    def test_the_agent_cannot_set_pr_url_or_the_branch(self, fake, publish_now, running, tasks, coding_settings):
        job, key = running()
        for extra in ({"pr_url": "https://github.com/evil/x/pull/1"}, {"pr_branch": "main"}, {"branch": "main"}):
            res = send(key, job.id, {**FIXED, **extra})
            assert res.status_code == 400 and res.json()["code"] == "INVALID_RESULT", extra
        assert not fake.calls("POST", r"/git/refs$")
        job.refresh_from_db()
        assert job.status == JobStatus.RUNNING and job.result_received_at is None

    def test_the_default_branch_is_never_pushed(
        self, fake, publish_now, running, tasks, issue, states, coding_settings
    ):
        job, key = running()
        with mock.patch.object(publish, "branch_name", return_value="main"), tasks.commit():
            send(key, job.id, FIXED)
        job.refresh_from_db()
        assert job.outcome == JobOutcome.JOB_ERROR and "Refused to push to main" in job.error_reason
        assert not fake.calls("POST", r"/git/refs$")
        issue.refresh_from_db()
        assert issue.state_id == states["todo"].id

    @pytest.mark.parametrize("branch", ["main", "MAIN", "develop", "feature/x", "nexus/../main"])
    def test_check_branch_refuses_everything_but_a_job_branch(self, branch):
        with pytest.raises(publish.PublishError):
            publish.check_branch(branch, ["main", "develop"])

    def test_an_existing_branch_is_left_alone(self, fake, publish_now, running, tasks, coding_settings):
        job, key = running()
        fake.repos["example/app"].refs[f"refs/heads/nexus/fix-bug/{job.id.hex[:8]}"] = "b" * 40
        with tasks.commit():
            send(key, job.id, FIXED)
        job.refresh_from_db()
        assert job.outcome == JobOutcome.JOB_ERROR and "already exists" in job.error_reason
        assert fake.repos["example/app"].refs[f"refs/heads/nexus/fix-bug/{job.id.hex[:8]}"] == "b" * 40

    @pytest.mark.parametrize(
        "fail,words",
        [
            (r"POST .*/git/trees$", "refused to store"),
            (r"POST .*/access_tokens$", "refused a token"),
            (r"POST .*/pulls$", "changes are on the branch"),
        ],
    )
    def test_a_failed_push_or_pull_request_is_a_job_error_not_failed(
        self, fake, publish_now, running, tasks, issue, states, coding_settings, fail, words
    ):
        fake.fail[fail] = (500, {"message": "Server Error"})
        job, key = running("write_and_run_test")
        with tasks.commit():
            assert send(key, job.id, BUG_FOUND).status_code == 200
        job.refresh_from_db()
        assert (job.status, job.outcome) == (JobStatus.FINISHED, JobOutcome.JOB_ERROR)
        assert job.error_reason.startswith("Could not open the pull request:") and words in job.error_reason
        assert "stay in the job's folder on Laptop" in job.error_reason
        assert job.pr_url == "" and job.is_retryable
        issue.refresh_from_db()
        assert issue.state_id == states["todo"].id
        assert not CodingJobChanges.objects.exists()

    def test_a_missing_starting_commit(self, fake, publish_now, running, tasks, coding_settings):
        job, key = running()
        with tasks.commit():
            send(key, job.id, FIXED, changes={**CHANGES, "base_commit": "c" * 40})
        job.refresh_from_db()
        assert job.outcome == JobOutcome.JOB_ERROR and "is not in example/app" in job.error_reason

    def test_pull_request_text_keeps_agent_and_work_item_text_as_data(
        self, fake, publish_now, running, tasks, issue, coding_settings
    ):
        issue.name = "Login @everyone [click](https://evil.example) ![x](https://evil.example/i.png)\nsecond"
        issue.save()
        job, key = running()
        summary = "Fixed.\n```\n@octocat <img src=x> [link](https://evil.example)\n````"
        with tasks.commit():
            send(key, job.id, {**FIXED, "summary": summary})
        (pull,) = fake.pulls
        assert "\n" not in pull["title"]
        body = pull["body"]
        fenced = body[body.index("`````text") :]
        # The agent's text sits inside a fence longer than any run of backticks in it.
        assert fenced.startswith("`````text\n") and fenced.rstrip().endswith("`````")
        assert "@octocat" not in body[: body.index("`````text")]
        assert "evil.example" not in body[: body.index("`````text")]


@pytest.mark.contract
class TestWithoutPullRequests:
    def test_no_app_set_up_applies_with_the_reason(self, settings, running, tasks, issue, states, coding_settings):
        settings.GITHUB_APP_ID = ""
        job, key = running()
        with tasks.commit():
            res = send(key, job.id, FIXED)
        assert res.json()["status"] == "finished"
        job.refresh_from_db()
        assert job.outcome == JobOutcome.FIXED and job.pr_url == ""
        html = IssueComment.objects.get(issue=issue).comment_html
        assert "No pull request: this CRM has no GitHub App set up" in html

    def test_app_not_installed(self, fake, running, tasks, issue, coding_settings):
        fake.repos["example/app"].installation = None
        job, key = running()
        with tasks.commit():
            send(key, job.id, FIXED)
        html = IssueComment.objects.get(issue=issue).comment_html
        assert "not installed on example/app" in html

    def test_not_a_github_repository(self, fake, running, tasks, issue, coding_settings):
        ProjectCodingSettings.objects.filter(pk=coding_settings.pk).update(repo_url="https://gitlab.com/example/app")
        job, key = running()
        with tasks.commit():
            send(key, job.id, FIXED)
        assert "not on GitHub" in IssueComment.objects.get(issue=issue).comment_html

    def test_no_changes_sent(self, fake, publish_now, running, tasks, issue, coding_settings):
        job, key = running()
        with tasks.commit():
            send(key, job.id, {**FIXED, "changed_files": []}, changes=None)
        assert "the job changed no files" in IssueComment.objects.get(issue=issue).comment_html
        assert not fake.calls("POST", r"/git/refs$")


@pytest.mark.contract
class TestWhilePublishing:
    def test_the_machine_is_done_with_it(self, fake, running, tasks, member, coding_settings):
        job, key = running()
        with mock.patch("plane.coding.tasks.publish_coding_job.delay") as delay, tasks.commit():
            send(key, job.id, FIXED)
        delay.assert_called_once_with(str(job.id))
        job.refresh_from_db()
        assert job.status == JobStatus.RUNNING and job.result_received_at is not None
        assert job.progress == "Opening a pull request."
        # Listed or not, the machine is not told to cancel it, and it is not ended as gone missing.
        res = beat(key, report(running=[job.id]))
        assert res.json()["cancel"] == []
        beat(key, report())
        job.refresh_from_db()
        assert job.status == JobStatus.RUNNING
        # The same result again changes nothing; another is refused.
        with mock.patch("plane.coding.tasks.publish_coding_job.delay"):
            assert send(key, job.id, FIXED).json()["changed"] is False
            assert send(key, job.id, {**FIXED, "summary": "other"}).status_code == 409

    def test_it_frees_the_machines_slot(self, fake, member, make_machine, start, tasks, coding_settings):
        _, key = make_machine(member[0])
        first = start(member[0])
        res = beat(key, report(total=1))
        assert [j["id"] for j in res.json()["jobs"]] == [str(first.id)]
        with mock.patch("plane.coding.tasks.publish_coding_job.delay"), tasks.commit():
            send(key, first.id, FIXED)
        second = start(member[0], action="write_test")
        res = beat(key, report(total=1))
        assert [j["id"] for j in res.json()["jobs"]] == [str(second.id)]

    def test_silent_machine_does_not_end_it_but_a_stuck_push_does(self, fake, running, tasks, coding_settings):
        job, key = running()
        with mock.patch("plane.coding.tasks.publish_coding_job.delay"), tasks.commit():
            send(key, job.id, FIXED)
        later = timezone.now() + timedelta(minutes=10)
        assert expire_jobs(now=later) == 0
        with tasks.commit():
            assert expire_jobs(now=timezone.now() + timedelta(minutes=16)) == 1
        job.refresh_from_db()
        assert job.outcome == JobOutcome.JOB_ERROR and "took too long" in job.error_reason
        assert not CodingJobChanges.objects.exists()

    def test_cancelled_while_publishing_pushes_nothing(self, fake, running, tasks, member, coding_settings):
        job, key = running()
        with mock.patch("plane.coding.tasks.publish_coding_job.delay"), tasks.commit():
            send(key, job.id, FIXED)
        with tasks.commit():
            cancel_job(CodingJob.objects.get(pk=job.pk), member[0])
        assert publish.publish_job(job.id) is None
        assert not fake.calls("POST", r"/git/refs$") and not fake.pulls
        assert not CodingJobChanges.objects.exists()


@pytest.mark.contract
class TestCloneAccess:
    def test_private_repository_gets_a_read_only_token(self, fake, member, make_machine, start, coding_settings):
        fake.repos["example/app"].private = True
        _, key = make_machine(member[0])
        job = start(member[0])
        order = run_on(key, job)
        token = order["clone_token"]
        assert fake.tokens[token] == {"repo": "example/app", "permissions": {"contents": "read"}}

    def test_public_repository_gets_none(self, fake, member, make_machine, start, coding_settings):
        _, key = make_machine(member[0])
        order = run_on(key, start(member[0]))
        assert "clone_token" not in order
        # Its visibility was asked without a token: none was made.
        assert not fake.calls("POST", r"/access_tokens$")

    def test_without_an_app_there_is_none(self, settings, member, make_machine, start, coding_settings):
        settings.GITHUB_APP_ID = ""
        _, key = make_machine(member[0])
        assert "clone_token" not in run_on(key, start(member[0], agent="claude"), agents=(CLAUDE_READY,))


@pytest.mark.contract
class TestChangesValidation:
    @pytest.mark.parametrize(
        "files",
        [
            [{"path": ".git/config", "mode": "100644", "content": b64("x")}],
            [{"path": "a/.GIT/hooks/pre-commit", "mode": "100755", "content": b64("x")}],
            [{"path": "../outside", "mode": "100644", "content": b64("x")}],
            [{"path": "/etc/passwd", "mode": "100644", "content": b64("x")}],
            [{"path": "a//b", "mode": "100644", "content": b64("x")}],
            [{"path": "a", "mode": "040000", "content": b64("x")}],
            [{"path": "a", "mode": "100644", "content": "not base64!"}],
            [{"path": "a", "mode": "100644"}],
            [{"path": "a", "deleted": True, "content": b64("x")}],
            [{"path": "a", "deleted": True}, {"path": "a", "deleted": True}],
            [{"path": "big", "mode": "100644", "content": base64.b64encode(b"x" * (3 * 1024 * 1024 + 1)).decode()}],
            [],
        ],
    )
    def test_refused(self, fake, running, tasks, coding_settings, files):
        job, key = running()
        res = send(key, job.id, FIXED, changes={"base_commit": BASE, "files": files})
        assert res.status_code == 400, files
        job.refresh_from_db()
        assert job.result_received_at is None and job.status == JobStatus.RUNNING

    def test_base_commit_must_be_a_sha(self, fake, running, coding_settings):
        job, key = running()
        assert send(key, job.id, FIXED, changes={**CHANGES, "base_commit": "HEAD"}).status_code == 400


@pytest.mark.contract
class TestRepositoryEndpoint:
    def url(self, workspace, project):
        return f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/coding-settings/repository/"

    def test_installed(self, fake, member, workspace, project, coding_settings):
        fake.repos["example/app"].private = True
        res = member[1].get(self.url(workspace, project))
        assert res.status_code == 200
        body = res.json()
        assert body["provider"] == "github" and body["installed"] is True and body["private"] is True
        assert body["pull_requests"] is True and body["reason"] is None
        assert body["install_url"] == "https://github.com/apps/nexus-coding/installations/new"

    def test_not_installed(self, fake, member, workspace, project, coding_settings):
        fake.repos["example/app"].installation = None
        body = member[1].get(self.url(workspace, project)).json()
        assert body["installed"] is False and body["pull_requests"] is False and "not installed" in body["reason"]

    def test_default_branch_mismatch(self, fake, member, workspace, project, coding_settings):
        fake.repos["example/app"].default_branch = "trunk"
        body = member[1].get(self.url(workspace, project)).json()
        assert body["pull_requests"] is True and "trunk" in body["reason"]

    def test_no_app(self, settings, member, workspace, project, coding_settings):
        settings.GITHUB_APP_ID = ""
        body = member[1].get(self.url(workspace, project)).json()
        assert body["app_configured"] is False and "no GitHub App" in body["reason"]

    def test_guests_cannot(self, fake, guest, workspace, project, coding_settings):
        assert guest[1].get(self.url(workspace, project)).status_code == 403

    def test_web_route(self, fake, session_client, workspace, project, coding_settings):
        res = session_client.get(f"/api/workspaces/{workspace.slug}/projects/{project.id}/coding-settings/repository/")
        assert res.status_code == 200


@pytest.mark.contract
class TestReviewFixes:
    def test_while_publishing_no_other_result_is_taken(self, fake, running, tasks, coding_settings):
        job, key = running()
        with mock.patch("plane.coding.tasks.publish_coding_job.delay"), tasks.commit():
            send(key, job.id, FIXED)
        res = send(key, job.id, {"outcome": "job_error", "reason": "x"}, changes=None)
        assert res.status_code == 409 and res.json()["code"] == "RESULT_ALREADY_APPLIED"
        # The same outcome again, its changes dropped on a retry: nothing changes.
        res = send(key, job.id, FIXED, changes=None)
        assert res.status_code == 200 and res.json()["changed"] is False
        job.refresh_from_db()
        assert job.outcome is None and job.result_received_at is not None

    def test_a_pull_request_opened_after_the_job_ended_keeps_its_link(
        self, fake, publish_now, running, tasks, coding_settings
    ):
        from plane.coding.exceptions import Conflict
        from plane.coding.models import CodingAuditEvent

        job, key = running()
        real = publish.apply_result
        calls = []

        def first_fails(*args, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise Conflict("ended")
            return real(*args, **kwargs)

        with mock.patch.object(publish, "apply_result", side_effect=first_fails), tasks.commit():
            send(key, job.id, FIXED)
        job.refresh_from_db()
        assert job.pr_url == "https://github.com/example/app/pull/1" and job.pr_branch.startswith("nexus/fix-bug/")
        assert job.outcome == JobOutcome.JOB_ERROR and "pull/1 was opened" in job.error_reason
        assert CodingAuditEvent.objects.filter(action="job.pull_request_kept", target_id=job.id).exists()

    def test_ci_workflows_are_not_pushed(self, fake, publish_now, running, tasks, coding_settings):
        job, key = running()
        changes = {
            "base_commit": BASE,
            "files": [{"path": ".github/workflows/ci.yml", "mode": "100644", "content": b64("on: push\n")}],
        }
        with tasks.commit():
            send(key, job.id, FIXED, changes=changes)
        job.refresh_from_db()
        assert job.outcome == JobOutcome.JOB_ERROR and "CI workflows" in job.error_reason
        assert not fake.calls("POST", r"/access_tokens$")

    def test_text_goes_in_the_tree_and_binary_as_blobs(self, fake, publish_now, running, tasks, coding_settings):
        job, key = running()
        changes = {
            "base_commit": BASE,
            "files": [
                {"path": "a.txt", "mode": "100644", "content": b64("hello\n")},
                {"path": "b.bin", "mode": "100644", "content": base64.b64encode(b"\x00\xff").decode()},
            ],
        }
        with tasks.commit():
            send(key, job.id, FIXED, changes=changes)
        assert len(fake.calls("POST", r"/git/blobs$")) == 1
        (tree,) = fake.calls("POST", r"/git/trees$")
        assert [e.get("content") for e in tree[2]["tree"] if e["path"] == "a.txt"] == ["hello\n"]

    def test_only_allowed_owners(self, settings, fake, member, make_machine, start, tasks, issue, coding_settings):
        settings.GITHUB_APP_ALLOWED_OWNERS = "someone-else, another"
        fake.repos["example/app"].private = True
        _, key = make_machine(member[0])
        job = start(member[0])
        order = run_on(key, job)
        assert "clone_token" not in order
        with tasks.commit():
            send(key, job.id, FIXED)
        assert "not allowed for example" in IssueComment.objects.get(issue=issue).comment_html
        assert not fake.calls("POST", r"/access_tokens$")


@pytest.mark.contract
class TestWhoSetsTheRepository:
    def url(self, workspace, project):
        return f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/coding-settings/"

    def test_a_project_admin_who_is_not_a_workspace_admin_cannot(self, make_user, workspace, project, coding_settings):
        from .conftest import ADMIN, MEMBER

        _, client = make_user(MEMBER, workspace=workspace, project=project, project_role=ADMIN)
        res = client.patch(
            self.url(workspace, project), {"repo_url": "https://github.com/other/private"}, format="json"
        )
        assert res.status_code == 403 and res.json()["code"] == "WORKSPACE_ADMIN_REQUIRED"
        # The rest of the settings are still theirs; the same repository again is not a change.
        res = client.patch(
            self.url(workspace, project), {"repo_url": coding_settings.repo_url, "enabled": True}, format="json"
        )
        assert res.status_code == 200

    def test_a_workspace_admin_can(self, admin, workspace, project, coding_settings):
        res = admin[1].patch(
            self.url(workspace, project), {"repo_url": "https://github.com/example/other"}, format="json"
        )
        assert res.status_code == 200
