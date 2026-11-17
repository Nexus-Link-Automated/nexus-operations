"""Parameters that take one id or several accept a JSON array as well as a string.

They were typed `str`, so a client sending `["a", "b"]` -- the natural shape for
a list -- failed schema validation and had to retry with a comma-separated
string, a round trip spent on nothing.
"""

from __future__ import annotations

import asyncio

import pytest
from fastmcp import Client

from plane_mcp.coercion import accepted_types


def test_every_id_list_parameter_accepts_an_array(listing):
    refused = [
        f"{tool['name']}.{name}"
        for tool in listing
        for name, prop in tool["inputSchema"]["properties"].items()
        if (name.endswith("_ids") or (tool["name"], name) == ("module", "members"))
        and "array" not in accepted_types(prop)
    ]
    assert not refused, f"these id lists refuse an array: {refused}"


def _call(tool: str, arguments: dict) -> str:
    """Call a tool through a real client, so schema validation runs. Returns the error text."""
    import plane_mcp.server as server_module

    async def run():
        async with Client(server_module.get_stdio_mcp()) as client:
            await client.call_tool(tool, arguments)

    try:
        asyncio.new_event_loop().run_until_complete(run())
    except Exception as exc:  # noqa: BLE001 - the error text is the assertion
        return str(exc)
    return ""


CASES = [
    (
        "cycle",
        {"action": "manage_workitems", "project_id": "p", "cycle_id": "c", "add_ids": ["a", "b"]},
        "cycles.add_work_items",
        "issue_ids",
    ),
    (
        "initiative",
        {"action": "manage_workitems", "initiative_id": "i", "add_ids": ["a", "b"]},
        "initiatives.work_items.add",
        "work_item_ids",
    ),
    (
        "initiative",
        {"action": "add_projects", "initiative_id": "i", "project_ids": ["a", "b"]},
        "initiatives.projects.add",
        "project_ids",
    ),
]


@pytest.mark.parametrize(
    "encode", [list, ",".join, lambda ids: f'["{ids[0]}", "{ids[1]}"]'], ids=["array", "csv", "json"]
)
@pytest.mark.parametrize(
    ("tool", "arguments", "method", "kwarg"), CASES, ids=[f"{c[0]}-{c[1]['action']}" for c in CASES]
)
def test_ids_reach_the_sdk_however_they_were_sent(spy, tool, arguments, method, kwarg, encode):
    arguments = {key: encode(value) if isinstance(value, list) else value for key, value in arguments.items()}

    error = _call(tool, arguments)

    assert "validation error" not in error, error
    sent = next(call for call in spy.recorder.calls if call.method == method)
    assert sent.kwargs[kwarg] == ["a", "b"]
