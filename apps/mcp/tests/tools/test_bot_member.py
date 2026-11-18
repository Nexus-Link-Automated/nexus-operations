"""bot_member: what reaches the API."""

from __future__ import annotations


def test_create_sends_the_role_as_a_number(registered, spy):
    registered["bot_member"].fn(action="create", name="Triage", role="guest", description="Sorts bugs")
    call = spy.recorder.only()
    assert call.method == "bot_members.create"
    assert call.kwargs["data"] == {"name": "Triage", "role": 5, "description": "Sorts bugs"}


def test_unknown_role_is_refused_before_any_request(registered, spy):
    assert registered["bot_member"].fn(action="create", name="x", role="admin").startswith("Error: role must be")
    assert not spy.recorder.calls


def test_update_needs_something_to_change(registered, spy):
    assert registered["bot_member"].fn(action="update", bot_id="b").startswith("Error:")
    assert not spy.recorder.calls


def test_new_token_and_remove(registered, spy):
    registered["bot_member"].fn(action="new_token", bot_id="b")
    registered["bot_member"].fn(action="remove", bot_id="b")
    assert [call.method for call in spy.recorder.calls] == ["bot_members.new_token", "bot_members.delete"]


def test_a_machine_for_a_bot(registered, spy):
    registered["coding_machine"].fn(action="add", name="Agent box", owner="bot-1")
    assert spy.recorder.only().kwargs == {"workspace_slug": "acme", "name": "Agent box", "owner": "bot-1"}
