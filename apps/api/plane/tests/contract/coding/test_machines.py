# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Machines: what owners and admins do with them, what the machine itself calls, and picking one for a job."""

import hashlib
import json
import re
from datetime import timedelta
from unittest import mock

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from plane.coding import machines
from plane.coding.models import CodingJob, CodingMachine, JobOutcome, JobStatus
from plane.coding.outcomes import apply_result
from plane.db.models import WorkspaceMember

from .conftest import GUEST, MEMBER

CODE_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$")
REPORT = {
    "hostname": "laptop",
    "os": "linux x64 Ubuntu 24.04",
    "version": "1.5.0",
    "capabilities": {
        "agents": [
            {"id": "codex", "installed": True, "signed_in": True, "version": "0.47.0"},
            {"id": "claude", "installed": False, "signed_in": False, "version": None},
        ],
        "toolchains": [{"name": "node", "version": "24.1.0"}, {"name": "python3", "version": "3.12.3"}],
        "docker": {"available": True, "version": "28.1.1"},
        "slots": {"total": 2, "free": 2},
    },
}


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@pytest.fixture(autouse=True)
def _reset_machine_throttles():
    cache.delete_pattern("coding_machine_*")
    yield
    cache.delete_pattern("coding_machine_*")


@pytest.fixture
def machines_url(workspace):
    def url(suffix="", base="/api/v1", slug=None):
        return f"{base}/workspaces/{slug or workspace.slug}/coding-machines/{suffix}"

    return url


@pytest.fixture
def member(make_user, workspace, project):
    return make_user(MEMBER, workspace=workspace, project=project, name="Mia Member")


@pytest.fixture
def other_member(make_user, workspace, project):
    return make_user(MEMBER, workspace=workspace, project=project, name="Otto Other")


def add(client, machines_url, name="Laptop", **kwargs):
    res = client.post(machines_url(**kwargs), {"name": name}, format="json")
    assert res.status_code == 201, res.data
    return res.json()


def join(code, **extra):
    return APIClient().post("/api/v1/coding-machines/join/", {"code": code, **extra}, format="json")


def heartbeat(key, body=None):
    client = APIClient()
    if key is not None:
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {key}")
    return client.post("/api/v1/coding-machines/heartbeat/", body if body is not None else REPORT, format="json")


@pytest.fixture
def joined(member, machines_url):
    """The member's machine, joined (awaiting approval), and its key."""
    added = add(member[1], machines_url)
    res = join(added["join_code"], hostname="laptop", os="linux", version="1.5.0")
    assert res.status_code == 201, res.data
    return CodingMachine.objects.get(pk=added["id"]), res.json()["key"]


@pytest.fixture
def active(joined, member, machines_url):
    machine, key = joined
    res = member[1].post(machines_url(f"{machine.id}/approve/"))
    assert res.status_code == 200, res.data
    machine.refresh_from_db()
    return machine, key


@pytest.mark.contract
class TestAdd:
    def test_member_adds_a_machine_and_gets_the_code_once(self, member, machines_url):
        user, client = member
        body = add(client, machines_url, name="  Laptop  ")
        assert CODE_RE.match(body["join_code"])
        assert body["name"] == "Laptop" and body["state"] == "pending" and body["owner"] == str(user.id)
        assert body["is_online"] is False and body["join_code_expired"] is False
        machine = CodingMachine.objects.get(pk=body["id"])
        # Only the hash is stored.
        assert machine.join_code_hash == sha256(body["join_code"].replace("-", ""))
        assert body["join_code"] not in json.dumps(
            CodingMachine.objects.filter(pk=machine.pk).values().first(), default=str
        )
        assert machine.join_code_expires_at - timezone.now() <= machines.JOIN_CODE_TTL
        # Never shown again.
        listed = client.get(machines_url()).json()
        assert [m["id"] for m in listed] == [body["id"]] and "join_code" not in listed[0]
        assert "join_code" not in client.get(machines_url(f"{body['id']}/")).json()

    @pytest.mark.parametrize("body", [{}, {"name": ""}, {"name": "   "}, {"name": "x" * 81}, {"name": "a", "os": "x"}])
    def test_invalid_name(self, member, machines_url, body):
        res = member[1].post(machines_url(), body, format="json")
        assert res.status_code == 400 and res.data["errors"]

    def test_guest_cannot_add_or_list(self, guest, machines_url):
        assert guest[1].post(machines_url(), {"name": "x"}, format="json").status_code == 403
        assert guest[1].get(machines_url()).status_code == 403
        assert not CodingMachine.objects.exists()

    def test_non_member_is_refused(self, make_user, machines_url):
        _, client = make_user()
        assert client.get(machines_url()).status_code == 403
        assert client.post(machines_url(), {"name": "x"}, format="json").status_code == 403

    def test_limit_per_owner(self, member, machines_url):
        with mock.patch.object(machines, "MAX_MACHINES_PER_OWNER", 2):
            add(member[1], machines_url, "a")
            add(member[1], machines_url, "b")
            res = member[1].post(machines_url(), {"name": "c"}, format="json")
        assert res.status_code == 409 and res.data["code"] == "MACHINE_LIMIT"

    def test_list_shows_only_own_machines(self, member, other_member, admin, machines_url):
        mine = add(member[1], machines_url, "mine")
        add(other_member[1], machines_url, "theirs")
        add(admin[1], machines_url, "admin's")
        assert [m["id"] for m in member[1].get(machines_url()).json()] == [mine["id"]]


@pytest.mark.contract
class TestJoin:
    def test_join_trades_the_code_for_a_hashed_key(self, member, machines_url, workspace):
        added = add(member[1], machines_url)
        res = join(added["join_code"], hostname="laptop", os="linux x64", version="1.5.0")
        assert res.status_code == 201, res.data
        body = res.json()
        assert body["key"].startswith("nxm_") and len(body["key"]) > 40
        assert body == {
            "machine_id": added["id"],
            "key": body["key"],
            "name": "Laptop",
            "workspace_slug": workspace.slug,
            "state": "awaiting_approval",
            "heartbeat_seconds": 15,
        }
        machine = CodingMachine.objects.get(pk=added["id"])
        assert machine.key_hash == sha256(body["key"])
        assert machine.join_code_hash is None and machine.join_code_expires_at is None
        assert (machine.hostname, machine.os, machine.version) == ("laptop", "linux x64", "1.5.0")
        assert machine.joined_at is not None and machine.is_online
        # The key itself is stored nowhere on the record.
        row = json.dumps(CodingMachine.objects.filter(pk=machine.pk).values().first(), default=str)
        assert body["key"] not in row and body["key"][4:] not in row

    def test_code_is_single_use(self, member, machines_url):
        code = add(member[1], machines_url)["join_code"]
        assert join(code).status_code == 201
        res = join(code)
        assert res.status_code == 400 and res.data["code"] == "JOIN_CODE_INVALID"

    def test_expired_code_is_refused_and_used_up(self, member, machines_url):
        added = add(member[1], machines_url)
        CodingMachine.objects.filter(pk=added["id"]).update(join_code_expires_at=timezone.now() - timedelta(seconds=1))
        machine = CodingMachine.objects.get(pk=added["id"])
        assert member[1].get(machines_url(f"{machine.id}/")).json()["join_code_expired"] is True
        res = join(added["join_code"])
        assert res.status_code == 400 and res.data["code"] == "JOIN_CODE_INVALID"
        machine.refresh_from_db()
        assert machine.join_code_hash is None and machine.state == "pending" and machine.key_hash is None
        # Pushing the expiry back does not revive it: the code is gone.
        CodingMachine.objects.filter(pk=machine.pk).update(join_code_expires_at=timezone.now() + timedelta(hours=1))
        assert join(added["join_code"]).status_code == 400

    def test_code_typed_loosely_still_works(self, member, machines_url):
        code = add(member[1], machines_url)["join_code"]
        loose = code.replace("-", " ").lower().replace("0", "o").replace("1", "l")
        assert join(loose).status_code == 201

    @pytest.mark.parametrize("body", [{}, {"code": ""}, {"code": "x", "extra": 1}])
    def test_invalid_body(self, body):
        res = APIClient().post("/api/v1/coding-machines/join/", body, format="json")
        assert res.status_code == 400

    def test_wrong_code(self, db):
        res = join("AAAA-BBBB-CCCC-DDDD")
        assert res.status_code == 400 and res.data["code"] == "JOIN_CODE_INVALID"

    def test_owner_who_became_a_guest_cannot_join(self, member, machines_url, workspace):
        code = add(member[1], machines_url)["join_code"]
        WorkspaceMember.objects.filter(workspace=workspace, member=member[0]).update(role=GUEST)
        assert join(code).status_code == 400

    def test_join_is_rate_limited(self, db):
        statuses = {join("AAAA-BBBB-CCCC-DDDD").status_code for _ in range(31)}
        assert 429 in statuses

    def test_join_exists_only_on_the_public_api(self):
        assert APIClient().post("/api/coding-machines/join/", {"code": "x"}, format="json").status_code == 404


@pytest.mark.contract
class TestHeartbeat:
    def test_heartbeat_stores_the_report_and_keeps_it_online(self, joined, member, machines_url):
        machine, key = joined
        CodingMachine.objects.filter(pk=machine.pk).update(last_seen_at=timezone.now() - timedelta(minutes=5))
        assert member[1].get(machines_url(f"{machine.id}/")).json()["is_online"] is False
        res = heartbeat(key)
        assert res.status_code == 200, res.data
        assert res.json() == {
            "machine_id": str(machine.id),
            "name": "Laptop",
            "state": "awaiting_approval",
            "heartbeat_seconds": 15,
            "jobs": [],
        }
        body = member[1].get(machines_url(f"{machine.id}/")).json()
        assert body["is_online"] is True
        assert body["capabilities"] == REPORT["capabilities"]
        assert (body["hostname"], body["os"]) == ("laptop", "linux x64 Ubuntu 24.04")

    def test_goes_offline_after_the_window(self, active):
        machine, key = active
        assert heartbeat(key).status_code == 200
        machine.refresh_from_db()
        assert machine.is_online
        later = timezone.now() + timedelta(seconds=46)
        with mock.patch("plane.coding.models.machine.timezone.now", return_value=later):
            assert not machine.is_online

    def test_empty_heartbeat_keeps_the_last_report(self, active):
        machine, key = active
        heartbeat(key)
        assert heartbeat(key, {}).status_code == 200
        machine.refresh_from_db()
        assert machine.capabilities == REPORT["capabilities"]

    @pytest.mark.parametrize(
        "change",
        [
            {"extra": 1},
            {"capabilities": {**REPORT["capabilities"], "secret": "x"}},
            {"capabilities": {**REPORT["capabilities"], "slots": {"total": 1, "free": 2}}},
            {"capabilities": {**REPORT["capabilities"], "slots": {"total": 99, "free": 1}}},
            {
                "capabilities": {
                    **REPORT["capabilities"],
                    "agents": [{"id": "gpt", "installed": True, "signed_in": True}],
                }
            },
            {"capabilities": {**REPORT["capabilities"], "toolchains": [{"name": "x", "version": "1"}] * 31}},
            {"capabilities": {"agents": []}},
            {"hostname": "h" * 256},
        ],
    )
    def test_invalid_report(self, active, change):
        res = heartbeat(active[1], {**REPORT, **change})
        assert res.status_code == 400 and res.data["errors"]

    @pytest.mark.parametrize("key", [None, "", "nope", "nxm_not-a-real-key"])
    def test_missing_or_unknown_key(self, active, key):
        res = heartbeat(key)
        assert res.status_code == 401
        assert res.data["code"] in ("MACHINE_KEY_INVALID", "MACHINE_UNKNOWN")

    def test_person_token_is_not_a_machine_key(self, active, member):
        client = member[1]
        res = client.post("/api/v1/coding-machines/heartbeat/", REPORT, format="json")
        assert res.status_code == 401

    def test_revoked_machine_cannot_connect(self, active, admin, machines_url):
        machine, key = active
        assert admin[1].post(machines_url(f"{machine.id}/revoke/")).status_code == 200
        res = heartbeat(key)
        assert res.status_code == 401 and res.data["code"] == "MACHINE_REVOKED"
        machine.refresh_from_db()
        assert machine.state == "revoked" and not machine.is_online

    def test_removed_machine_cannot_connect(self, active, member, machines_url):
        machine, key = active
        assert member[1].delete(machines_url(f"{machine.id}/")).status_code == 204
        assert not CodingMachine.all_objects.filter(pk=machine.pk).exists()
        res = heartbeat(key)
        assert res.status_code == 401 and res.data["code"] == "MACHINE_UNKNOWN"

    @pytest.mark.parametrize("change", [{"is_active": False}, {"role": GUEST}])
    def test_owner_who_left_or_became_a_guest_is_refused(self, active, workspace, change):
        machine, key = active
        WorkspaceMember.objects.filter(workspace=workspace, member=machine.owner).update(**change)
        res = heartbeat(key)
        assert res.status_code == 403 and res.data["code"] == "MACHINE_OWNER_NOT_ALLOWED"

    def test_heartbeat_does_not_undo_a_revoke(self, active, admin):
        machine, key = active
        authenticated = machines.authenticate_key(key)
        machines.revoke(machine, admin[0])
        machines.heartbeat(authenticated, REPORT)
        machine.refresh_from_db()
        assert machine.state == "revoked"
        assert heartbeat(key).status_code == 401


@pytest.mark.contract
class TestOwnerActions:
    def test_approve(self, joined, member, machines_url):
        machine, _ = joined
        res = member[1].post(machines_url(f"{machine.id}/approve/"))
        assert res.status_code == 200 and res.json()["state"] == "active" and res.json()["approved_at"]
        # Again: no change.
        assert member[1].post(machines_url(f"{machine.id}/approve/")).json()["state"] == "active"

    def test_cannot_approve_before_joining(self, member, machines_url):
        added = add(member[1], machines_url)
        res = member[1].post(machines_url(f"{added['id']}/approve/"))
        assert res.status_code == 409 and res.data["code"] == "MACHINE_NOT_JOINED"

    def test_cannot_approve_a_revoked_machine(self, joined, member, admin, machines_url):
        machine, _ = joined
        admin[1].post(machines_url(f"{machine.id}/revoke/"))
        res = member[1].post(machines_url(f"{machine.id}/approve/"))
        assert res.status_code == 409 and res.data["code"] == "MACHINE_REVOKED"

    def test_rename(self, joined, member, machines_url):
        machine, _ = joined
        res = member[1].patch(machines_url(f"{machine.id}/"), {"name": "Desktop"}, format="json")
        assert res.status_code == 200 and res.json()["name"] == "Desktop"
        res = member[1].patch(machines_url(f"{machine.id}/"), {"name": ""}, format="json")
        assert res.status_code == 400
        res = member[1].patch(machines_url(f"{machine.id}/"), {"state": "active"}, format="json")
        assert res.status_code == 400

    def test_another_member_cannot_see_or_touch_it(self, joined, other_member, machines_url):
        machine, _ = joined
        client = other_member[1]
        assert client.get(machines_url(f"{machine.id}/")).status_code == 404
        assert client.patch(machines_url(f"{machine.id}/"), {"name": "x"}, format="json").status_code == 404
        assert client.post(machines_url(f"{machine.id}/approve/")).status_code == 404
        assert client.delete(machines_url(f"{machine.id}/")).status_code == 404
        assert client.post(machines_url(f"{machine.id}/revoke/")).status_code == 403
        machine.refresh_from_db()
        assert (machine.name, machine.state) == ("Laptop", "awaiting_approval")

    def test_an_admin_reads_and_revokes_but_does_not_own(self, joined, admin, machines_url):
        machine, _ = joined
        client = admin[1]
        assert client.get(machines_url(f"{machine.id}/")).status_code == 200
        assert client.patch(machines_url(f"{machine.id}/"), {"name": "x"}, format="json").status_code == 403
        assert client.post(machines_url(f"{machine.id}/approve/")).status_code == 403
        assert client.delete(machines_url(f"{machine.id}/")).status_code == 403
        assert CodingMachine.objects.filter(pk=machine.pk, state="awaiting_approval").exists()

    def test_owner_who_became_a_guest_cannot_approve_or_rename(self, joined, member, workspace, machines_url):
        machine, _ = joined
        WorkspaceMember.objects.filter(workspace=workspace, member=member[0]).update(role=GUEST)
        assert member[1].post(machines_url(f"{machine.id}/approve/")).status_code == 403
        assert member[1].patch(machines_url(f"{machine.id}/"), {"name": "x"}, format="json").status_code == 403

    def test_remove(self, joined, member, machines_url):
        machine, _ = joined
        assert member[1].delete(machines_url(f"{machine.id}/")).status_code == 204
        assert member[1].get(machines_url(f"{machine.id}/")).status_code == 404

    def test_machine_of_another_workspace_is_404(self, other_workspace, member, machines_url):
        machine, _ = machines.add_machine(other_workspace["workspace"], other_workspace["owner"], "Theirs")
        assert member[1].get(machines_url(f"{machine.id}/")).status_code == 404

    def test_session_routes(self, session_client, member, machines_url):
        body = add(session_client, machines_url, base="/api")
        assert CODE_RE.match(body["join_code"])
        assert [m["id"] for m in session_client.get(machines_url(base="/api")).json()] == [body["id"]]
        res = session_client.patch(machines_url(f"{body['id']}/", base="/api"), {"name": "Desk"}, format="json")
        assert res.status_code == 200 and res.json()["name"] == "Desk"
        assert session_client.get(machines_url("all/", base="/api")).status_code == 200
        assert session_client.delete(machines_url(f"{body['id']}/", base="/api")).status_code == 204


@pytest.mark.contract
class TestAdmin:
    def test_admin_lists_every_machine(self, member, other_member, admin, machines_url):
        a = add(member[1], machines_url, "a")
        b = add(other_member[1], machines_url, "b")
        res = admin[1].get(machines_url("all/"))
        assert res.status_code == 200
        listed = {m["id"]: m for m in res.json()}
        assert set(listed) == {a["id"], b["id"]}
        assert listed[a["id"]]["owner_display_name"] == "Mia Member"

    def test_members_and_guests_cannot_list_all(self, member, guest, machines_url):
        assert member[1].get(machines_url("all/")).status_code == 403
        assert guest[1].get(machines_url("all/")).status_code == 403

    def test_admin_revokes(self, active, admin, machines_url):
        machine, _ = active
        res = admin[1].post(machines_url(f"{machine.id}/revoke/"))
        assert res.status_code == 200
        body = res.json()
        assert body["state"] == "revoked" and body["revoked_by"] == str(admin[0].id) and body["is_online"] is False
        # Again: no change.
        assert admin[1].post(machines_url(f"{machine.id}/revoke/")).json()["revoked_at"] == body["revoked_at"]

    def test_owner_who_is_not_an_admin_cannot_revoke(self, active, member, machines_url):
        machine, _ = active
        assert member[1].post(machines_url(f"{machine.id}/revoke/")).status_code == 403

    def test_guest_cannot_revoke(self, active, guest, machines_url):
        machine, _ = active
        assert guest[1].post(machines_url(f"{machine.id}/revoke/")).status_code in (403, 404)
        machine.refresh_from_db()
        assert machine.state == "active"

    def test_a_pending_machine_can_be_revoked_and_its_code_dies(self, member, admin, machines_url):
        added = add(member[1], machines_url)
        assert admin[1].post(machines_url(f"{added['id']}/revoke/")).status_code == 200
        assert join(added["join_code"]).status_code == 400


START = {"action": "fix_bug", "agent": "codex"}


@pytest.mark.contract
class TestJobMachine:
    def start(self, client, jobs_url, issue, **body):
        return client.post(jobs_url(issue.project_id, issue.id), {**START, **body}, format="json")

    def test_start_on_own_active_machine(self, coding_settings, active, member, issue, jobs_url):
        machine, _ = active
        # Offline is fine: the job waits in the queue.
        CodingMachine.objects.filter(pk=machine.pk).update(last_seen_at=None)
        res = self.start(member[1], jobs_url, issue, machine=str(machine.id))
        assert res.status_code == 201, res.data
        assert res.json()["machine"] == str(machine.id)
        assert CodingJob.objects.get(pk=res.json()["id"]).machine_id == machine.id

    @pytest.mark.parametrize("machine", [None, "absent"])
    def test_auto(self, coding_settings, member, issue, jobs_url, machine):
        body = {} if machine == "absent" else {"machine": None}
        res = self.start(member[1], jobs_url, issue, **body)
        assert res.status_code == 201 and res.json()["machine"] is None

    def test_someone_elses_machine_is_refused(self, coding_settings, active, other_member, admin, issue, jobs_url):
        machine, _ = active
        for client in (other_member[1], admin[1]):
            res = self.start(client, jobs_url, issue, machine=str(machine.id))
            assert res.status_code == 400 and res.data["code"] == "MACHINE_NOT_AVAILABLE"
        assert not CodingJob.objects.exists()

    def test_unapproved_or_revoked_machine_is_refused(
        self, coding_settings, joined, member, admin, issue, jobs_url, machines_url
    ):
        machine, _ = joined
        res = self.start(member[1], jobs_url, issue, machine=str(machine.id))
        assert res.status_code == 400 and res.data["code"] == "MACHINE_NOT_AVAILABLE"
        member[1].post(machines_url(f"{machine.id}/approve/"))
        admin[1].post(machines_url(f"{machine.id}/revoke/"))
        res = self.start(member[1], jobs_url, issue, machine=str(machine.id))
        assert res.status_code == 400 and res.data["code"] == "MACHINE_NOT_AVAILABLE"

    def test_unknown_or_malformed_machine(self, coding_settings, member, issue, jobs_url):
        res = self.start(member[1], jobs_url, issue, machine="00000000-0000-0000-0000-000000000000")
        assert res.status_code == 400 and res.data["code"] == "MACHINE_NOT_AVAILABLE"
        res = self.start(member[1], jobs_url, issue, machine="laptop")
        assert res.status_code == 400 and res.data["errors"]["machine"]

    def test_removing_the_machine_leaves_the_job_on_auto(
        self, coding_settings, active, member, issue, jobs_url, machines_url
    ):
        machine, _ = active
        job_id = self.start(member[1], jobs_url, issue, machine=str(machine.id)).json()["id"]
        member[1].delete(machines_url(f"{machine.id}/"))
        assert CodingJob.objects.get(pk=job_id).machine_id is None

    def _errored_job(self, client, jobs_url, issue, **body):
        job = CodingJob.objects.get(pk=self.start(client, jobs_url, issue, **body).json()["id"])
        apply_result(job, {"outcome": JobOutcome.JOB_ERROR.value, "reason": "offline"})
        return job

    def test_retry_keeps_the_machine_for_its_owner(self, coding_settings, active, member, issue, jobs_url, tasks):
        machine, _ = active
        job = self._errored_job(member[1], jobs_url, issue, machine=str(machine.id))
        res = member[1].post(jobs_url(issue.project_id, issue.id, f"{job.id}/retry/"), {}, format="json")
        assert res.status_code == 201, res.data
        assert res.json()["machine"] == str(machine.id)

    def test_retry_by_someone_else_goes_to_auto(
        self, coding_settings, active, member, other_member, issue, jobs_url, tasks
    ):
        machine, _ = active
        job = self._errored_job(member[1], jobs_url, issue, machine=str(machine.id))
        res = other_member[1].post(jobs_url(issue.project_id, issue.id, f"{job.id}/retry/"), {}, format="json")
        assert res.status_code == 201 and res.json()["machine"] is None

    def test_retry_with_explicit_machine_or_auto(self, coding_settings, active, member, issue, jobs_url, tasks):
        machine, _ = active
        job = self._errored_job(member[1], jobs_url, issue, machine=str(machine.id))
        url = jobs_url(issue.project_id, issue.id, f"{job.id}/retry/")
        res = member[1].post(url, {"machine": None}, format="json")
        assert res.status_code == 201 and res.json()["machine"] is None
        again = CodingJob.objects.get(pk=res.json()["id"])
        apply_result(again, {"outcome": JobOutcome.JOB_ERROR.value, "reason": "offline"})
        res = member[1].post(
            jobs_url(issue.project_id, issue.id, f"{again.id}/retry/"), {"machine": str(machine.id)}, format="json"
        )
        assert res.status_code == 201 and res.json()["machine"] == str(machine.id)
        assert CodingJob.objects.filter(status=JobStatus.QUEUED).count() == 1
