"""The PQL reference must describe the parser the API actually runs.

It promised 5 conditions while the parser took 10, and offered a teamspace
field and function that the parser refuses on this deployment.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from plane_mcp.pql_reference import (
    DOCUMENTED_MAX_CONDITIONS,
    PQL_FIELD_DESCRIPTION,
    PQL_FIELD_HINT,
    PQL_FULL_REFERENCE,
    PQL_MAX_CONDITIONS,
)

API_PQL = Path(__file__).resolve().parents[2] / "api" / "plane" / "nexus" / "pql.py"
REFERENCES = {"brief": PQL_FIELD_DESCRIPTION, "full": PQL_FULL_REFERENCE, "hint": PQL_FIELD_HINT}


def _api_constant(name: str) -> object:
    for node in ast.parse(API_PQL.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} is not assigned in {API_PQL}")


@pytest.mark.skipif(not API_PQL.exists(), reason="needs the full repository checkout")
def test_the_condition_limit_matches_the_api_parser():
    assert PQL_MAX_CONDITIONS == _api_constant("MAX_CONDITIONS")


def test_the_documented_limit_leaves_room_for_the_project_scope():
    """count and a workspace-wide list AND a project condition onto the caller's query."""
    assert DOCUMENTED_MAX_CONDITIONS == PQL_MAX_CONDITIONS - 1


@pytest.mark.parametrize("detail", ["brief", "full"])
def test_the_reference_states_the_limit(detail):
    text = REFERENCES[detail]
    assert f"Max {DOCUMENTED_MAX_CONDITIONS} conditions" in text
    assert "{max_conditions}" not in text


@pytest.mark.parametrize("detail", sorted(REFERENCES))
def test_the_reference_offers_no_teamspace_filters(detail):
    """The API answers teamspaceProject and membersOf("teamspace:...") with an error."""
    assert "teamspace" not in REFERENCES[detail].lower()
