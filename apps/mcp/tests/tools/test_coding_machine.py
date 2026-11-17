"""coding_machine: what reaches the API, who may do what, and how its refusals read."""

from __future__ import annotations

import pytest
from plane.errors.errors import HttpError

from plane_mcp.middleware import ValidateActionArguments


def test_list_is_your_own_and_list_all_is_the_workspace(registered, spy):
    registered["coding_machine"].fn(action="list")
    registered["coding_machine"].fn(action="list_all")
    assert spy.recorder.methods == ["coding_machines.list", "coding_machines.list_all"]
    assert all(call.kwargs == {"workspace_slug": "acme"} for call in spy.recorder.calls)


def test_add_sends_the_trimmed_name_and_returns_the_join_code(registered, spy):
    spy.returns["coding_machines.create"] = {"id": "m-1", "state": "pending", "join_code": "ABCD-EFGH-JKLM-NPQR"}
    result = registered["coding_machine"].fn(action="add", name="  Laptop  ")
    assert spy.recorder.only().kwargs == {"workspace_slug": "acme", "name": "Laptop"}
    assert result["join_code"] == "ABCD-EFGH-JKLM-NPQR"


def test_the_add_description_says_the_join_code_is_shown_once_and_not_kept(registered):
    description = registered["coding_machine"].description
    assert "shown once" in description
    assert "join command" in description
    assert "never store" in description


@pytest.mark.parametrize(
    ("action", "method"),
    [
        ("get", "coding_machines.retrieve"),
        ("approve", "coding_machines.approve"),
        ("revoke", "coding_machines.revoke"),
        ("remove", "coding_machines.delete"),
    ],
)
def test_a_machine_action_reaches_its_endpoint(action, method, registered, spy):
    registered["coding_machine"].fn(action=action, machine_id="m-1")
    call = spy.recorder.only()
    assert (call.method, call.kwargs) == (method, {"workspace_slug": "acme", "machine_id": "m-1"})


def test_rename_sends_the_new_name(registered, spy):
    registered["coding_machine"].fn(action="rename", machine_id="m-1", name="Desktop")
    assert spy.recorder.only().kwargs == {"workspace_slug": "acme", "machine_id": "m-1", "name": "Desktop"}


def test_remove_answers_none(registered, spy):
    assert registered["coding_machine"].fn(action="remove", machine_id="m-1") is None


@pytest.mark.parametrize(
    ("args", "missing"),
    [
        ({"action": "add", "name": "   "}, "name"),
        ({"action": "rename", "machine_id": "m-1"}, "name"),
        ({"action": "rename", "name": "Desktop"}, "machine_id"),
        ({"action": "approve"}, "machine_id"),
    ],
)
def test_a_missing_argument_is_named_before_any_request(args, missing, registered, spy):
    result = registered["coding_machine"].fn(**args)
    assert result.startswith("Error:") and missing in result
    assert not spy.recorder.calls


@pytest.mark.parametrize(
    ("args", "stray"),
    [
        ({"action": "list", "name": "x"}, "name"),
        ({"action": "add", "name": "x", "machine_id": "m-1"}, "machine_id"),
        ({"action": "revoke", "machine_id": "m-1", "name": "x"}, "name"),
    ],
)
def test_an_argument_the_action_does_not_take_is_refused(args, stray):
    message = ValidateActionArguments().rejection("coding_machine", args)
    assert message and stray in message


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (409, {"error": "The machine has not joined yet.", "code": "MACHINE_NOT_JOINED"}, "(MACHINE_NOT_JOINED)"),
        (409, {"error": "At most 20 machines.", "code": "MACHINE_LIMIT"}, "(MACHINE_LIMIT)"),
        (403, {"error": "Only workspace admins can do this.", "code": "FORBIDDEN"}, "Only workspace admins"),
        (404, {"error": "Machine not found.", "code": "NOT_FOUND"}, "Machine not found."),
    ],
)
def test_a_refusal_carries_the_api_reason(status, body, expected, registered, spy):
    spy.returns["coding_machines.approve"] = HttpError(f"HTTP {status}", status, body)
    result = registered["coding_machine"].fn(action="approve", machine_id="m-1")
    assert result.startswith("Error: ") and expected in result


def test_a_server_error_is_not_swallowed(registered, spy):
    spy.returns["coding_machines.list_all"] = HttpError("HTTP 500", 500, {"error": "boom"})
    with pytest.raises(HttpError):
        registered["coding_machine"].fn(action="list_all")
