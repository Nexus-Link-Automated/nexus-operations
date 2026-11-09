"""workitem search: what reaches the endpoint, and what the caller learns from it.

The search endpoint reads `search`, `limit`, `project_id` and `workspace_search`
and nothing else, and it cuts results off at `limit` without saying so.
"""

from __future__ import annotations

from plane.models.work_items import WorkItemSearch, WorkItemSearchItem

from plane_mcp.middleware import ValidateActionArguments
from plane_mcp.tools.workitem import SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT


def _found(count: int) -> WorkItemSearch:
    return WorkItemSearch(
        issues=[
            WorkItemSearchItem(
                id=f"w-{index}",
                name=f"Item {index}",
                sequence_id=index,
                project__identifier="ENG",
                project_id="p-1",
                workspace__slug="acme",
            )
            for index in range(count)
        ]
    )


def _search(registered, **arguments):
    return registered["workitem"].fn(action="search", query="login", **arguments)


def _sent(spy) -> dict:
    """The query parameters the SDK would put on the request."""
    return spy.recorder.only().kwargs["params"].model_dump(exclude_none=True)


def test_search_sends_the_default_limit_and_no_project(registered, spy):
    spy.returns["work_items.search"] = _found(3)

    result = _search(registered)

    assert _sent(spy) == {"limit": SEARCH_DEFAULT_LIMIT}
    assert [issue["id"] for issue in result["issues"]] == ["w-0", "w-1", "w-2"]
    assert result["limit"] == SEARCH_DEFAULT_LIMIT
    assert result["may_be_truncated"] is False
    assert "hint" not in result


def test_search_passes_limit_and_project_id_through(registered, spy):
    spy.returns["work_items.search"] = _found(1)

    result = _search(registered, limit=25, project_id="p-1")

    assert _sent(spy) == {"limit": 25, "project_id": "p-1"}
    assert result["limit"] == 25


def test_a_full_page_is_reported_as_possibly_truncated(registered, spy):
    spy.returns["work_items.search"] = _found(SEARCH_DEFAULT_LIMIT)

    result = _search(registered)

    assert result["may_be_truncated"] is True
    assert "limit" in result["hint"]


def test_a_short_page_at_an_explicit_limit_is_not_truncated(registered, spy):
    spy.returns["work_items.search"] = _found(4)

    assert _search(registered, limit=5)["may_be_truncated"] is False


def test_a_limit_outside_the_range_is_refused_before_any_call(registered, spy):
    for bad in (-1, SEARCH_MAX_LIMIT + 1):
        result = _search(registered, limit=bad)
        assert result.startswith("Error:") and "limit" in result
    assert not spy.recorder.calls


def test_the_description_says_what_search_matches(registered):
    assert "title and identifier only" in registered["workitem"].description


def test_search_refuses_the_parameters_the_endpoint_ignores():
    rejection = ValidateActionArguments().rejection
    for param in ("expand", "fields", "external_id", "external_source", "order_by"):
        message = rejection("workitem", {"action": "search", "query": "q", param: "x"})
        assert message and f"does not take: {param}" in message
    assert rejection("workitem", {"action": "search", "query": "q", "limit": 5, "project_id": "p"}) is None


def test_retrieve_only_accepts_what_the_endpoint_reads():
    rejection = ValidateActionArguments().rejection
    for action, target in (
        ("retrieve", {"project_id": "p", "workitem_id": "w"}),
        ("retrieve_by_identifier", {"workitem_identifier": "ENG-1"}),
    ):
        for param in ("external_id", "external_source", "order_by"):
            message = rejection("workitem", {"action": action, **target, param: "x"})
            assert message and f"does not take: {param}" in message
        assert rejection("workitem", {"action": action, **target, "expand": "state", "fields": "id"}) is None


def test_retrieve_forwards_expand_and_fields_only(registered, spy):
    registered["workitem"].fn(action="retrieve", project_id="p", workitem_id="w", expand="state", fields="id")

    assert _sent(spy) == {"expand": "state", "fields": "id"}
