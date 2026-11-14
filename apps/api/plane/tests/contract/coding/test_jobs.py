# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""/coding-jobs/ on a work item: start, list, get, cancel and retry, on the public API and the web app's routes."""

from unittest import mock

import pytest
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from plane.coding import services
from plane.coding.exceptions import Conflict

from plane.coding.models import CodingJob, JobOutcome, JobStatus, ProjectCodingSettings
from plane.coding.outcomes import apply_result
from plane.db.models import Issue, IssueComment, IssueSubscriber, Project

from .conftest import ADMIN, GUEST, MEMBER, make_issue

START = {"action": "fix_bug", "agent": "codex"}


def start(client, jobs_url, issue, body=None, **kwargs):
    return client.post(jobs_url(issue.project_id, issue.id, **kwargs), body or START, format="json")


@pytest.mark.contract
class TestStart:
    def test_member_starts_a_queued_job(self, coding_settings, member, issue, jobs_url):
        user, client = member
        res = start(client, jobs_url, issue)
        assert res.status_code == 201, res.data
        body = res.json()
        assert body["status"] == "queued" and body["outcome"] is None and body["is_active"] is True
        assert (body["action"], body["agent"], body["work_item"]) == ("fix_bug", "codex", str(issue.id))
        assert body["requested_by"] == str(user.id) and body["retry_of"] is None
        job = CodingJob.objects.get(pk=body["id"])
        assert (job.workspace_id, job.project_id) == (issue.workspace_id, issue.project_id)

    def test_admin_can_start_every_action_with_either_agent(self, coding_settings, admin, issue, jobs_url):
        for action, agent in (("fix_bug", "claude"), ("write_test", "codex"), ("write_and_run_test", "claude")):
            res = start(admin[1], jobs_url, issue, {"action": action, "agent": agent})
            assert res.status_code == 201, res.data

    def test_guest_cannot_start(self, coding_settings, guest, issue, jobs_url, project):
        project.guest_view_all_features = True
        project.save()
        res = start(guest[1], jobs_url, issue)
        assert res.status_code == 403
        assert not CodingJob.objects.exists()

    @pytest.mark.parametrize(
        "body",
        [
            {"action": "deploy", "agent": "codex"},
            {"action": "fix_bug", "agent": "gpt"},
            {"action": "fix_bug"},
            {**START, "machine": "laptop"},
        ],
    )
    def test_invalid_body(self, coding_settings, admin, issue, jobs_url, body):
        res = start(admin[1], jobs_url, issue, body)
        assert res.status_code == 400 and res.data["errors"]

    def test_one_active_job_per_action(self, coding_settings, admin, member, issue, jobs_url):
        first = start(admin[1], jobs_url, issue)
        res = start(member[1], jobs_url, issue)
        assert res.status_code == 409
        assert res.data["code"] == "JOB_ACTIVE" and res.data["job_id"] == first.data["id"]
        # Another action on the same work item is fine.
        assert start(member[1], jobs_url, issue, {"action": "write_test", "agent": "codex"}).status_code == 201

    @pytest.mark.parametrize("settings_kwargs", [None, {"enabled": False}, {"enabled": True, "repo_url": ""}])
    def test_not_configured(self, admin, issue, project, jobs_url, settings_kwargs):
        if settings_kwargs is not None:
            ProjectCodingSettings.objects.create(project=project, **{"repo_url": "https://x.test/r", **settings_kwargs})
        res = start(admin[1], jobs_url, issue)
        assert res.status_code == 400 and res.data["code"] == "CODING_NOT_CONFIGURED"


@pytest.mark.contract
class TestRead:
    def test_list_and_get(self, coding_settings, admin, member, issue, jobs_url, project):
        a = start(admin[1], jobs_url, issue).data
        b = start(member[1], jobs_url, issue, {"action": "write_test", "agent": "claude"}).data
        other = make_issue(project, "Unrelated")
        CodingJob.objects.create(issue=other, action="fix_bug", agent="codex")

        res = member[1].get(jobs_url(project.id, issue.id))
        assert res.status_code == 200
        assert [row["id"] for row in res.data["results"]] == [b["id"], a["id"]]

        res = member[1].get(jobs_url(project.id, issue.id) + "?action=write_test")
        assert [row["id"] for row in res.data["results"]] == [b["id"]]
        res = member[1].get(jobs_url(project.id, issue.id) + "?status=finished")
        assert res.data["results"] == []
        assert member[1].get(jobs_url(project.id, issue.id) + "?status=done").status_code == 400

        res = member[1].get(jobs_url(project.id, issue.id, f"{a['id']}/"))
        assert res.status_code == 200 and res.data["id"] == a["id"]

    def test_job_of_another_work_item_is_404(self, coding_settings, admin, issue, project, jobs_url):
        job = start(admin[1], jobs_url, issue).data
        other = make_issue(project, "Unrelated")
        assert admin[1].get(jobs_url(project.id, other.id, f"{job['id']}/")).status_code == 404

    def test_guest_sees_jobs_only_on_items_they_can_see(
        self, coding_settings, make_user, workspace, project, issue, jobs_url, admin
    ):
        guest_user, guest_client = make_user(GUEST, workspace=workspace, project=project)
        job = start(admin[1], jobs_url, issue).data
        # A restricted guest (project not open to guests) sees only work items they created.
        assert guest_client.get(jobs_url(project.id, issue.id)).status_code == 404
        assert guest_client.get(jobs_url(project.id, issue.id, f"{job['id']}/")).status_code == 404
        own = make_issue(project, "Guest's own")
        Issue.objects.filter(pk=own.pk).update(created_by=guest_user)
        CodingJob.objects.create(issue=own, action="fix_bug", agent="codex")
        res = guest_client.get(jobs_url(project.id, own.id))
        assert res.status_code == 200 and len(res.data["results"]) == 1
        # With the project open to guests they see the rest too.
        project.guest_view_all_features = True
        project.save()
        assert guest_client.get(jobs_url(project.id, issue.id, f"{job['id']}/")).status_code == 200


@pytest.mark.contract
class TestOtherWorkspace:
    def test_ids_from_another_workspace_are_404(
        self, coding_settings, admin, issue, project, jobs_url, other_workspace
    ):
        client = admin[1]
        other = other_workspace
        # Its project, its work item under our project, and its job under our work item.
        assert client.get(jobs_url(other["project"].id, other["issue"].id)).status_code == 404
        assert client.post(jobs_url(other["project"].id, other["issue"].id), START, format="json").status_code == 404
        assert client.get(jobs_url(project.id, other["issue"].id)).status_code == 404
        assert client.get(jobs_url(project.id, issue.id, f"{other['job'].id}/")).status_code == 404
        assert client.post(jobs_url(project.id, issue.id, f"{other['job'].id}/cancel/")).status_code == 404
        assert client.post(jobs_url(project.id, issue.id, f"{other['job'].id}/retry/")).status_code == 404
        other["job"].refresh_from_db()
        assert other["job"].status == JobStatus.QUEUED

    def test_outsider_of_the_workspace_is_refused(self, coding_settings, issue, jobs_url, make_user, other_workspace):
        _, outsider = make_user(ADMIN, workspace=other_workspace["workspace"])
        assert outsider.get(jobs_url(issue.project_id, issue.id)).status_code == 403
        assert start(outsider, jobs_url, issue).status_code == 403

    def test_workspace_member_outside_the_project_is_refused(
        self, coding_settings, make_user, workspace, issue, jobs_url
    ):
        _, client = make_user(MEMBER, workspace=workspace)
        assert client.get(jobs_url(issue.project_id, issue.id)).status_code == 403

    def test_archived_project_is_404(self, coding_settings, admin, issue, project, jobs_url):
        from django.utils import timezone

        Project.objects.filter(pk=project.pk).update(archived_at=timezone.now())
        assert admin[1].get(jobs_url(project.id, issue.id)).status_code == 404


@pytest.mark.contract
class TestCancel:
    def test_requester_cancels_and_the_item_gets_the_job_error_comment(
        self, coding_settings, member, issue, jobs_url, tasks
    ):
        job = start(member[1], jobs_url, issue).data
        with tasks.commit():
            res = member[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/"))
        assert res.status_code == 200, res.data
        assert res.data["status"] == "cancelled" and res.data["outcome"] == "job_error"
        assert res.data["error_reason"] == "Cancelled by Mia Member." and res.data["is_retryable"] is True
        comment = IssueComment.objects.get(issue=issue)
        assert "Job did not finish:</strong> Cancelled by Mia Member." in comment.comment_html
        issue.refresh_from_db()
        assert issue.state.name == "Todo"

    def test_admin_cancels_someone_elses_job(self, coding_settings, member, admin, issue, jobs_url, tasks):
        job = start(member[1], jobs_url, issue).data
        res = admin[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/"))
        assert res.status_code == 200

    def test_another_member_cannot_cancel(
        self, coding_settings, member, make_user, workspace, project, issue, jobs_url
    ):
        job = start(member[1], jobs_url, issue).data
        _, other = make_user(MEMBER, workspace=workspace, project=project)
        assert other.post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/")).status_code == 403
        _, guest = make_user(GUEST, workspace=workspace, project=project)
        project.guest_view_all_features = True
        project.save()
        assert guest.post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/")).status_code == 403
        assert CodingJob.objects.get(pk=job["id"]).status == JobStatus.QUEUED

    def test_only_an_active_job(self, coding_settings, admin, issue, jobs_url, tasks):
        job = start(admin[1], jobs_url, issue).data
        url = jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/")
        assert admin[1].post(url).status_code == 200
        res = admin[1].post(url)
        assert res.status_code == 409 and res.data["code"] == "JOB_NOT_ACTIVE"
        assert IssueComment.objects.filter(issue=issue).count() == 1

    def test_cancelling_frees_the_action(self, coding_settings, admin, issue, jobs_url, tasks):
        job = start(admin[1], jobs_url, issue).data
        admin[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/"))
        assert start(admin[1], jobs_url, issue).status_code == 201


@pytest.mark.contract
class TestRetry:
    def test_retry_a_cancelled_job(self, coding_settings, admin, member, issue, jobs_url, tasks):
        job = start(admin[1], jobs_url, issue).data
        admin[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/"))
        res = member[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/retry/"), {}, format="json")
        assert res.status_code == 201, res.data
        body = res.json()
        assert body["retry_of"] == job["id"] and body["status"] == "queued"
        assert body["requested_by"] == str(member[0].id) and body["agent"] == "codex"
        assert body["action"] == job["action"]

    def test_retry_a_job_error_with_another_agent(self, coding_settings, admin, issue, jobs_url, tasks):
        job = CodingJob.objects.get(pk=start(admin[1], jobs_url, issue).data["id"])
        apply_result(job, {"outcome": "job_error", "reason": "Machine offline."})
        res = admin[1].post(
            jobs_url(issue.project_id, issue.id, f"{job.id}/retry/"), {"agent": "claude"}, format="json"
        )
        assert res.status_code == 201 and res.data["agent"] == "claude"

    def test_only_from_job_error_or_cancelled(self, coding_settings, admin, issue, jobs_url, tasks):
        job = CodingJob.objects.get(pk=start(admin[1], jobs_url, issue).data["id"])
        url = jobs_url(issue.project_id, issue.id, f"{job.id}/retry/")
        res = admin[1].post(url, {}, format="json")
        assert res.status_code == 409 and res.data["code"] == "JOB_NOT_RETRYABLE"
        apply_result(job, {"outcome": "could_not_fix", "attempted": "a", "reason": "b"})
        job.refresh_from_db()
        assert job.outcome == JobOutcome.COULD_NOT_FIX
        assert admin[1].post(url, {}, format="json").status_code == 409

    def test_retry_respects_active_jobs_and_settings(self, coding_settings, admin, issue, jobs_url, tasks):
        job = start(admin[1], jobs_url, issue).data
        url = jobs_url(issue.project_id, issue.id, f"{job['id']}/retry/")
        admin[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/"))
        assert admin[1].post(url, {}, format="json").status_code == 201
        res = admin[1].post(url, {}, format="json")
        assert res.status_code == 409 and res.data["code"] == "JOB_ACTIVE"
        CodingJob.objects.filter(status=JobStatus.QUEUED).update(status=JobStatus.CANCELLED)
        coding_settings.enabled = False
        coding_settings.save()
        res = admin[1].post(url, {}, format="json")
        assert res.status_code == 400 and res.data["code"] == "CODING_NOT_CONFIGURED"

    def test_guest_cannot_retry(self, coding_settings, admin, guest, issue, project, jobs_url, tasks):
        project.guest_view_all_features = True
        project.save()
        job = start(admin[1], jobs_url, issue).data
        admin[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/"))
        assert (
            guest[1].post(jobs_url(issue.project_id, issue.id, f"{job['id']}/retry/"), {}, format="json").status_code
            == 403
        )


@pytest.mark.contract
class TestWebAppRoutes:
    @pytest.fixture
    def browser(self, create_user):
        """A real session, as the web app has: login cookie, and the app's own origin on writes."""
        client = APIClient(HTTP_ORIGIN="http://testserver")
        client.force_login(create_user)
        return client

    def test_session_routes_mirror_the_public_api(self, coding_settings, browser, issue, jobs_url, tasks):
        res = start(browser, jobs_url, issue, base="/api")
        assert res.status_code == 201, res.data
        job_id = res.data["id"]
        assert browser.get(jobs_url(issue.project_id, issue.id, base="/api")).data["results"][0]["id"] == job_id
        assert browser.get(jobs_url(issue.project_id, issue.id, f"{job_id}/", base="/api")).status_code == 200
        assert browser.post(jobs_url(issue.project_id, issue.id, f"{job_id}/cancel/", base="/api")).status_code == 200
        res = browser.post(jobs_url(issue.project_id, issue.id, f"{job_id}/retry/", base="/api"), {}, format="json")
        assert res.status_code == 201

    def test_session_writes_from_another_origin_are_refused(self, coding_settings, create_user, issue, jobs_url):
        client = APIClient(HTTP_ORIGIN="https://elsewhere.example")
        client.force_login(create_user)
        assert start(client, jobs_url, issue, base="/api").status_code == 403
        assert not CodingJob.objects.exists()

    def test_session_routes_need_a_session(self, coding_settings, issue, jobs_url, admin):
        # A personal access token is for /api/v1/ only.
        assert admin[1].get(jobs_url(issue.project_id, issue.id, base="/api")).status_code in (401, 403)

    def test_the_public_api_takes_no_session(self, coding_settings, browser, issue, jobs_url):
        assert browser.get(jobs_url(issue.project_id, issue.id)).status_code in (401, 403)


@pytest.mark.contract
class TestEligibilityAndSubscription:
    def test_not_on_archived_or_draft_work_items(self, coding_settings, admin, project, jobs_url):
        from django.utils import timezone

        archived = make_issue(project, "Old")
        Issue.objects.filter(pk=archived.pk).update(archived_at=timezone.now())
        draft = make_issue(project, "Draft", is_draft=True)
        for item in (archived, draft):
            res = start(admin[1], jobs_url, item)
            assert res.status_code == 400 and res.data["code"] == "WORK_ITEM_NOT_ELIGIBLE"
        assert not CodingJob.objects.exists()

    def test_the_requester_is_subscribed(self, coding_settings, member, issue, jobs_url):
        assert start(member[1], jobs_url, issue).status_code == 201
        assert IssueSubscriber.objects.filter(issue=issue, subscriber=member[0]).count() == 1
        assert start(member[1], jobs_url, issue, {"action": "write_test", "agent": "codex"}).status_code == 201
        assert IssueSubscriber.objects.filter(issue=issue, subscriber=member[0]).count() == 1


@pytest.mark.contract
class TestOneActiveJobInTheDatabase:
    def test_the_constraint_holds_without_the_check(self, issue, create_user):
        CodingJob.objects.create(issue=issue, action="fix_bug", agent="codex", requested_by=create_user)
        with pytest.raises(IntegrityError), transaction.atomic():
            CodingJob.objects.create(issue=issue, action="fix_bug", agent="claude", requested_by=create_user)
        # Ended jobs do not count.
        CodingJob.objects.update(status=JobStatus.CANCELLED)
        CodingJob.objects.create(issue=issue, action="fix_bug", agent="claude", requested_by=create_user)

    def test_a_start_that_loses_the_race_gets_job_active(self, coding_settings, issue, create_user):
        first = CodingJob.objects.create(issue=issue, action="fix_bug", agent="codex", requested_by=create_user)
        real = services._active_conflict
        calls = []

        def stale_check(*args):
            # The first check runs before the other request's insert commits, so it sees nothing.
            calls.append(args)
            return None if len(calls) == 1 else real(*args)

        with mock.patch.object(services, "_active_conflict", stale_check):
            with pytest.raises(Conflict) as exc:
                services.start_job(issue, "fix_bug", "codex", create_user)
        assert exc.value.code == "JOB_ACTIVE" and exc.value.extra["job_id"] == str(first.id)


@pytest.mark.contract
class TestCancelRaces:
    def test_a_job_that_ended_meanwhile_is_not_active(self, coding_settings, admin, issue, tasks):
        job = CodingJob.objects.create(issue=issue, action="fix_bug", agent="codex", requested_by=admin[0])
        stale = CodingJob.objects.get(pk=job.pk)
        services.cancel_job(job, admin[0])
        with pytest.raises(Conflict) as exc:
            services.cancel_job(stale, admin[0])
        assert exc.value.code == "JOB_NOT_ACTIVE"
        assert IssueComment.objects.filter(issue=issue).count() == 1

    def test_workspace_admin_who_is_a_project_member_may_cancel(
        self, coding_settings, member, make_user, workspace, project, issue, jobs_url, tasks
    ):
        job = start(member[1], jobs_url, issue).data
        _, ws_admin = make_user(ADMIN, workspace=workspace, project=project, project_role=MEMBER)
        assert ws_admin.post(jobs_url(issue.project_id, issue.id, f"{job['id']}/cancel/")).status_code == 200
