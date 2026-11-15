"""coding_job: what reaches the API, and how its refusals read."""

from __future__ import annotations

from plane.errors.errors import HttpError

W = {"project_id": "p", "workitem_id": "w"}


def test_start_sends_the_job_action_and_agent(registered, spy):
    registered["coding_job"].fn(action="start", **W, job_action="write_and_run_test", agent="claude")
    call = spy.recorder.only()
    assert call.method == "coding_jobs.create"
    assert call.kwargs["data"] == {"action": "write_and_run_test", "agent": "claude"}


def test_unknown_vocabulary_is_refused_before_any_request(registered, spy):
    result = registered["coding_job"].fn(action="start", **W, job_action="deploy", agent="codex")
    assert result.startswith("Error: job_action must be one of")
    result = registered["coding_job"].fn(action="start", **W, job_action="fix_bug", agent="gpt")
    assert result.startswith("Error: agent must be one of")
    assert not spy.recorder.calls


def test_list_filters_by_status_and_job_action(registered, spy):
    registered["coding_job"].fn(action="list", **W, status="queued", job_action="fix_bug", per_page=5)
    assert spy.recorder.only().kwargs["params"] == {"per_page": 5, "status": "queued", "action": "fix_bug"}


def test_retry_keeps_the_agent_unless_one_is_given(registered, spy):
    registered["coding_job"].fn(action="retry", **W, job_id="j")
    registered["coding_job"].fn(action="retry", **W, job_id="j", agent="claude")
    assert [call.kwargs["data"] for call in spy.recorder.calls] == [{}, {"agent": "claude"}]


def test_settings_update_sends_only_what_is_given(registered, spy):
    registered["coding_job"].fn(
        action="settings_update", project_id="p", enabled=False, ready_state_id="s-1", failed_state_id="none"
    )
    assert spy.recorder.only().kwargs["data"] == {"enabled": False, "ready_state": "s-1", "failed_state": None}


def test_settings_update_can_clear_the_repo(registered, spy):
    registered["coding_job"].fn(action="settings_update", project_id="p", repo_url="none")
    assert spy.recorder.only().kwargs["data"] == {"repo_url": ""}


def test_settings_update_with_nothing_to_change(registered, spy):
    result = registered["coding_job"].fn(action="settings_update", project_id="p")
    assert result.startswith("Error:") and not spy.recorder.calls


def test_a_refusal_carries_the_api_reason_and_code(registered, spy):
    body = {"error": "This work item already has an active job for this action.", "code": "JOB_ACTIVE", "job_id": "j-1"}
    spy.returns["coding_jobs.create"] = HttpError("HTTP 409: Conflict", 409, body)
    result = registered["coding_job"].fn(action="start", **W, job_action="fix_bug", agent="codex")
    assert result == f"Error: {body['error']} (JOB_ACTIVE) job_id=j-1"


def test_a_server_error_is_not_swallowed(registered, spy):
    spy.returns["coding_jobs.retrieve"] = HttpError("HTTP 500", 500, {"error": "boom"})
    try:
        registered["coding_job"].fn(action="get", **W, job_id="j")
    except HttpError as exc:
        assert exc.status_code == 500
    else:
        raise AssertionError("a 500 must surface as an error")


def test_start_runs_on_auto_unless_a_machine_is_given(registered, spy):
    start = dict(action="start", **W, job_action="fix_bug", agent="codex")
    registered["coding_job"].fn(**start)
    registered["coding_job"].fn(**start, machine="m-1")
    registered["coding_job"].fn(**start, machine="auto")
    assert [call.kwargs["data"] for call in spy.recorder.calls] == [
        {"action": "fix_bug", "agent": "codex"},
        {"action": "fix_bug", "agent": "codex", "machine": "m-1"},
        {"action": "fix_bug", "agent": "codex", "machine": None},
    ]


def test_retry_keeps_the_machine_unless_one_or_auto_is_given(registered, spy):
    """Left out, the API keeps the retried job's machine; "auto" is an explicit null."""
    registered["coding_job"].fn(action="retry", **W, job_id="j")
    registered["coding_job"].fn(action="retry", **W, job_id="j", machine="m-2")
    registered["coding_job"].fn(action="retry", **W, job_id="j", agent="claude", machine="Auto")
    assert [call.kwargs["data"] for call in spy.recorder.calls] == [
        {},
        {"machine": "m-2"},
        {"agent": "claude", "machine": None},
    ]


def test_a_machine_that_is_not_yours_reads_as_the_api_refusal(registered, spy):
    body = {"error": "That machine is not one of your approved machines.", "code": "MACHINE_NOT_AVAILABLE"}
    spy.returns["coding_jobs.create"] = HttpError("HTTP 400", 400, body)
    result = registered["coding_job"].fn(action="start", **W, job_action="fix_bug", agent="codex", machine="m-9")
    assert result == f"Error: {body['error']} (MACHINE_NOT_AVAILABLE)"
