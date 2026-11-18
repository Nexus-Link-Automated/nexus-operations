# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Step 8: limits on jobs, a queue that does not wait forever, the audit trail, and how long records are kept."""

from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone

from plane.coding import retention
from plane.coding.dispatch import expire_jobs
from plane.coding.models import CodingAuditEvent, CodingJob, CodingJobEvent, JobOutcome, JobStatus

from .conftest import make_issue
from .test_dispatch import READY, _reset_machine_throttles, run_on  # noqa: F401


@pytest.fixture(autouse=True)
def _clear_start_throttle():
    cache.delete_pattern("throttle_coding_job_start*")
    yield
    cache.delete_pattern("throttle_coding_job_start*")


def start_url(jobs_url, project, issue):
    return jobs_url(project.id, issue.id)


@pytest.mark.contract
class TestLimits:
    def test_at_most_n_active_jobs_per_person(self, settings, member, project, coding_settings, jobs_url):
        settings.CODING_MAX_ACTIVE_JOBS_PER_USER = 2
        for index in range(2):
            issue = make_issue(project, f"Item {index}")
            assert (
                member[1].post(start_url(jobs_url, project, issue), {"action": "fix_bug", "agent": "codex"}).status_code
                == 201
            )
        third = make_issue(project, "Third")
        res = member[1].post(start_url(jobs_url, project, third), {"action": "fix_bug", "agent": "codex"})
        assert res.status_code == 429 and res.json()["code"] == "JOB_LIMIT"

    def test_starts_per_hour(self, settings, member, project, coding_settings, jobs_url):
        settings.CODING_JOB_STARTS_PER_HOUR = 2
        statuses = []
        for index in range(3):
            issue = make_issue(project, f"Item {index}")
            statuses.append(
                member[1].post(start_url(jobs_url, project, issue), {"action": "fix_bug", "agent": "codex"}).status_code
            )
        assert statuses == [201, 201, 429]
        # Reading is not limited.
        assert member[1].get(start_url(jobs_url, project, issue)).status_code == 200


@pytest.mark.contract
class TestQueueTtl:
    def test_a_job_no_machine_took_ends(self, member, start, tasks, issue):
        job = start(member[0])
        CodingJob.objects.filter(pk=job.pk).update(created_at=timezone.now() - timedelta(hours=25))
        fresh = start(member[0], action="write_test")
        with tasks.commit():
            assert expire_jobs() == 1
        job.refresh_from_db()
        assert job.outcome == JobOutcome.JOB_ERROR and "No machine took the job within 24 hours" in job.error_reason
        fresh.refresh_from_db()
        assert fresh.status == JobStatus.QUEUED

    def test_zero_means_no_limit(self, settings, member, start, tasks):
        settings.CODING_JOB_QUEUE_TTL_HOURS = "0"
        job = start(member[0])
        CodingJob.objects.filter(pk=job.pk).update(created_at=timezone.now() - timedelta(days=30))
        assert expire_jobs() == 0


@pytest.mark.contract
class TestAudit:
    def url(self, workspace, query=""):
        return f"/api/v1/workspaces/{workspace.slug}/coding-audit/{query}"

    def test_records_who_did_what(
        self, member, make_machine, project, coding_settings, jobs_url, admin, workspace, tasks
    ):
        machine, key = make_machine(member[0])
        issue = make_issue(project)
        job_id = (
            member[1].post(start_url(jobs_url, project, issue), {"action": "fix_bug", "agent": "codex"}).json()["id"]
        )
        run_on(key, CodingJob.objects.get(pk=job_id))
        with tasks.commit():
            member[1].post(jobs_url(project.id, issue.id, f"{job_id}/cancel/"))
        body = admin[1].get(self.url(workspace)).json()
        actions = [event["action"] for event in body["results"]]
        assert actions[:4] == ["job.cancelled", "job.finished", "job.handed_out", "job.started"]
        started = body["results"][3]
        assert started["actor"] == str(member[0].id) and started["details"]["agent"] == "codex"
        assert body["results"][2]["actor_name"] == "machine Laptop"
        assert "machine.joined" in actions
        only_jobs = admin[1].get(self.url(workspace, "?action=job")).json()["results"]
        assert {event["action"].split(".")[0] for event in only_jobs} == {"job"}
        mine = admin[1].get(self.url(workspace, f"?actor={member[0].id}")).json()["results"]
        assert mine and all(event["actor"] == str(member[0].id) for event in mine)

    def test_admins_only(self, member, workspace):
        assert member[1].get(self.url(workspace)).status_code == 403

    def test_pages(self, admin, workspace):
        for _ in range(105):
            CodingAuditEvent.objects.create(workspace=workspace, action="job.started", target_type="job")
        first = admin[1].get(self.url(workspace)).json()
        assert len(first["results"]) == 100 and first["next_before"]
        second = admin[1].get(self.url(workspace, f"?before={first['next_before'].replace('+', '%2B')}")).json()
        assert len(second["results"]) == 5 and second["next_before"] is None


@pytest.mark.contract
class TestRetention:
    def test_old_progress_and_audit_go(self, member, start, workspace):
        old = start(member[0])
        CodingJob.objects.filter(pk=old.pk).update(
            status=JobStatus.FINISHED, outcome=JobOutcome.JOB_ERROR, finished_at=timezone.now() - timedelta(days=31)
        )
        recent = start(member[0], action="write_test")
        for job in (old, recent):
            CodingJobEvent.objects.create(job=job, seq=1, kind="status", text="x")
        CodingAuditEvent.objects.create(workspace=workspace, action="job.started", target_type="job")
        CodingAuditEvent.objects.filter(workspace=workspace).update(created_at=timezone.now() - timedelta(days=366))
        CodingAuditEvent.objects.create(workspace=workspace, action="job.started", target_type="job")
        assert retention.purge() == {"events": 1, "audit": 1}
        assert list(CodingJobEvent.objects.values_list("job_id", flat=True)) == [recent.id]
