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
