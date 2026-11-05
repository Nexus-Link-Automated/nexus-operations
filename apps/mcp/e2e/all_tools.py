"""Exercise every action of every MCP tool against a live Nexus Operations instance.

Runs one realistic scenario through the MCP server itself (not the SDK), so it
checks the whole chain: tool argument handling -> plane-sdk -> /api/v1 -> back.
It creates a throwaway project "E2E <random>" plus workspace-level records
(customers, releases, ...) and deletes them again at the end.

    MCP_URL=http://localhost:8211/mcp PLANE_PAT=plane_api_... PLANE_WORKSPACE=acme \
        python e2e/all_tools.py

Or run e2e/run.sh, which builds a throwaway instance from this repo and runs this against it.

Run it against a test instance. It writes to the workspace it is given.
Exit status is non-zero if any action failed; every action is listed either way.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import string
import sys
from datetime import date, timedelta
from typing import Any

from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

TODAY = date.today()
SUFFIX = "".join(random.choices(string.ascii_uppercase, k=3))

V: dict[str, Any] = {}  # ids saved by earlier steps, referenced as "$name"
RESULTS: list[tuple[str, str, str]] = []  # (tool.action, PASS|FAIL|EXPECTED, detail)


def _resolve(value: Any) -> Any:
    if isinstance(value, str) and value.startswith("$"):
        return V[value[1:]]
    if isinstance(value, list):
        return [_resolve(v) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v) for k, v in value.items()}
    return value


def _payload(result: Any) -> Any:
    if result.structured_content is not None:
        data = result.structured_content
        return data.get("result", data) if isinstance(data, dict) and set(data) == {"result"} else data
    text = "".join(getattr(c, "text", "") for c in result.content)
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text


def _failed(result: Any, data: Any) -> str | None:
    if result.is_error:
        return str(data)[:400]
    if isinstance(data, str) and data.startswith("Error"):
        return data[:400]
    if isinstance(data, dict) and "error" in data and "id" not in data:
        return json.dumps(data)[:400]
    return None


def first(data: Any, key: str = "id") -> Any:
    """The first row's `key` from a list or paginated response."""
    rows = data.get("results", data) if isinstance(data, dict) else data
    return rows[0][key]


async def step(client: Client, tool: str, args: dict, save: dict | None = None, expect_error: str = "") -> Any:
    action = args.get("action", "read")
    name = f"{tool}.{action}"
    try:
        result = await client.call_tool(tool, _resolve(args), raise_on_error=False)
        data = _payload(result)
        problem = _failed(result, data)
    except Exception as exc:  # a transport or validation failure is a failed action too
        data, problem = None, f"{type(exc).__name__}: {exc}"[:400]
    if expect_error:
        ok = problem is not None and expect_error.lower() in problem.lower()
        RESULTS.append((name, "EXPECTED" if ok else "FAIL", problem or f"expected refusal containing {expect_error!r}"))
        return data
    if problem:
        RESULTS.append((name, "FAIL", problem))
        return data
    try:
        for var, getter in (save or {}).items():
            V[var] = getter(data) if callable(getter) else data[getter]
    except Exception as exc:
        RESULTS.append((name, "FAIL", f"could not read {list(save)} from {str(data)[:300]}: {exc!r}"))
        return data
    RESULTS.append((name, "PASS", ""))
    return data


async def scenario(c: Client) -> None:
    s = lambda tool, args, save=None, **kw: step(c, tool, args, save, **kw)  # noqa: E731
    P = "$project"

    # Identity and workspace
    await s("member", {"action": "me"}, {"me": "id"})
    await s("workspace", {"action": "retrieve"})
    await s("workspace", {"action": "get_features"})
    await s("workspace", {"action": "update_features", "customers": True, "initiatives": True})
    await s("get_pql_reference", {})

    # Project
    await s("project", {"action": "create", "name": f"E2E {SUFFIX}", "identifier": f"E2E{SUFFIX}"}, {"project": "id"})
    await s("project", {"action": "list"})
    await s("project", {"action": "retrieve", "project_id": P})
    await s("project", {"action": "update", "project_id": P, "description": "end-to-end run"})
    await s("project", {"action": "get_features", "project_id": P})
    await s(
        "project",
        {"action": "update_features", "project_id": P, "cycles": True, "modules": True, "intakes": True, "pages": True},
    )

    # Members and roles
    await s(
        "member",
        {"action": "list_workspace"},
        {"teammate": lambda d: next(m["id"] for m in d.get("results", d) if m["id"] != V["me"])},
    )
    await s("member", {"action": "list_project", "project_id": P})
    await s("member", {"action": "list_roles"}, {"role": first})
    await s("member", {"action": "retrieve_role", "role_id": "$role"})

    # States and labels
    await s("state", {"action": "list", "project_id": P}, {"state_any": first})
    await s("state", {"action": "list"}, expect_error="per project")
    await s(
        "state",
        {"action": "create", "project_id": P, "name": "Review", "color": "#EF4444", "group": "started"},
        {"state": "id"},
    )
    await s("state", {"action": "retrieve", "project_id": P, "state_id": "$state"})
    await s("state", {"action": "update", "project_id": P, "state_id": "$state", "name": "In review"})
    await s(
        "state",
        {"action": "list", "project_id": P},
        {"done_state": lambda d: next(r["id"] for r in d.get("results", d) if r["group"] == "completed")},
    )
    await s("label", {"action": "create", "project_id": P, "name": "vip", "color": "#22C55E"}, {"label": "id"})
    await s("label", {"action": "list", "project_id": P})
    await s("label", {"action": "retrieve", "project_id": P, "label_id": "$label"})
    await s("label", {"action": "update", "project_id": P, "label_id": "$label", "description": "very important"})

    # Work items
    await s(
        "workitem",
        {"action": "create", "project_id": P, "name": "Alpha", "priority": "high", "labels": ["$label"]},
        {"w1": "id", "w1_seq": "sequence_id"},
    )
    await s("workitem", {"action": "create", "project_id": P, "name": "Beta", "priority": "low"}, {"w2": "id"})
    await s("workitem", {"action": "retrieve", "project_id": P, "workitem_id": "$w1"})
    V["w1_ident"] = f"E2E{SUFFIX}-{V.get('w1_seq', 1)}"
    await s("workitem", {"action": "retrieve_by_identifier", "workitem_identifier": "$w1_ident"})
    await s("workitem", {"action": "search", "query": "Alpha"})
    await s("workitem", {"action": "list", "project_id": P})
    await s("workitem", {"action": "list", "pql": 'priority = "high"'})
    await s("workitem", {"action": "list", "project_id": P, "pql": 'priority IN ("high", "low") AND title ~ "Al"'})
    await s("workitem", {"action": "list", "pql": "priority === nonsense"}, expect_error="pql")
    await s("workitem", {"action": "count", "project_id": P})
    await s("workitem", {"action": "count", "group_by": "priority"})
    await s("workitem", {"action": "update", "project_id": P, "workitem_id": "$w1", "description_html": "<p>Hi</p>"})
    await s("workitem", {"action": "manage_assignee", "project_id": P, "workitem_id": "$w1", "add_user_id": "$me"})
    await s("workitem", {"action": "manage_label", "project_id": P, "workitem_id": "$w1", "remove_label_id": "$label"})

    # Comments, links, activity, attachments
    W = {"project_id": P, "workitem_id": "$w1"}
    await s("workitem_comment", {"action": "create", **W, "comment_html": "<p>first</p>"}, {"comment": "id"})
    await s("workitem_comment", {"action": "list", **W})
    await s("workitem_comment", {"action": "retrieve", **W, "comment_id": "$comment"})
    await s("workitem_comment", {"action": "update", **W, "comment_id": "$comment", "comment_html": "<p>edited</p>"})
    await s("workitem_comment", {"action": "delete", **W, "comment_id": "$comment"})
    await s("workitem_link", {"action": "create", **W, "url": "https://example.com/spec", "title": "Spec"}, {"link": "id"})
    await s("workitem_link", {"action": "list", **W})
    await s("workitem_link", {"action": "retrieve", **W, "link_id": "$link"})
    await s("workitem_link", {"action": "update", **W, "link_id": "$link", "title": "Spec v2"})
    await s("workitem_link", {"action": "delete", **W, "link_id": "$link"})
    await s("workitem_activity", {"action": "list", **W}, {"activity": first})
    await s("workitem_activity", {"action": "retrieve", **W, "activity_id": "$activity"})
    await s(
        "workitem_attachment",
        {"action": "upload_from_url", **W, "url": "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png", "name": "logo.png"},
    )
    await s("workitem_attachment", {"action": "list", **W}, {"attachment": first})
    await s("workitem_attachment", {"action": "read", **W, "attachment_id": "$attachment"})
    await s("workitem_attachment", {"action": "download_url", **W, "attachment_id": "$attachment"})
    await s("workitem_attachment", {"action": "delete", **W, "attachment_id": "$attachment"})

    # Relations and relation definitions
    await s("workitem_relation", {"action": "create", **W, "workitem_ids": ["$w2"], "relation_type": "blocked_by"})
    await s("workitem_relation", {"action": "list", **W})
    await s("workitem_relation", {"action": "delete", **W, "related_workitem_id": "$w2", "is_dependency": True})
    await s(
        "workitem_relation",
        {"action": "create_definition", "name": f"Implements {SUFFIX}", "outward": "implements", "inward": "implemented by"},
        {"reldef": "id"},
    )
    await s("workitem_relation", {"action": "list_definitions"})
    await s("workitem_relation", {"action": "update_definition", "definition_id": "$reldef", "color": "#0EA5E9"})
    await s("workitem_relation", {"action": "delete_definition", "definition_id": "$reldef"})

    # Work logs
    await s("work_log", {"action": "create", **W, "duration": 30, "description": "pairing"}, {"worklog": "id"})
    await s("work_log", {"action": "list", **W})
    await s("work_log", {"action": "update", **W, "work_log_id": "$worklog", "duration": 45})
    await s("project", {"action": "worklog_summary", "project_id": P})
    await s("work_log", {"action": "delete", **W, "work_log_id": "$worklog"})

    # Cycles
    start, end = TODAY.isoformat(), (TODAY + timedelta(days=14)).isoformat()
    later, later_end = (TODAY + timedelta(days=15)).isoformat(), (TODAY + timedelta(days=28)).isoformat()
    cyc = {"project_id": P}
    await s(
        "cycle",
        {"action": "create", **cyc, "name": "Sprint 1", "owned_by": "$me", "start_date": start, "end_date": end},
        {"c1": "id"},
    )
    await s(
        "cycle",
        {"action": "create", **cyc, "name": "Sprint 2", "owned_by": "$me", "start_date": later, "end_date": later_end},
        {"c2": "id"},
    )
    await s("cycle", {"action": "list", **cyc})
    await s("cycle", {"action": "retrieve", **cyc, "cycle_id": "$c1"})
    await s("cycle", {"action": "update", **cyc, "cycle_id": "$c1", "description": "first sprint"})
    await s("cycle", {"action": "manage_workitems", **cyc, "cycle_id": "$c1", "add_ids": "$w1"})
    await s("cycle", {"action": "list_workitems", **cyc, "cycle_id": "$c1"})
    await s("cycle", {"action": "complete", **cyc, "cycle_id": "$c1"})
    await s("cycle", {"action": "transfer_workitems", **cyc, "cycle_id": "$c1", "new_cycle_id": "$c2"})
    await s("cycle", {"action": "archive", **cyc, "cycle_id": "$c1"})
    await s("cycle", {"action": "unarchive", **cyc, "cycle_id": "$c1"})
    await s("cycle", {"action": "delete", **cyc, "cycle_id": "$c2"})

    # Modules
    await s("module", {"action": "create", "project_id": P, "name": "Onboarding"}, {"module": "id"})
    await s("module", {"action": "list", "project_id": P})
    await s("module", {"action": "retrieve", "project_id": P, "module_id": "$module"})
    await s("module", {"action": "update", "project_id": P, "module_id": "$module", "status": "in-progress"})
    await s("module", {"action": "manage_workitems", "project_id": P, "module_id": "$module", "add_ids": "$w1"})
    await s("module", {"action": "list_workitems", "project_id": P, "module_id": "$module"})
    await s("module", {"action": "update", "project_id": P, "module_id": "$module", "status": "completed"})
    await s("module", {"action": "archive", "project_id": P, "module_id": "$module"})
    await s("module", {"action": "unarchive", "project_id": P, "module_id": "$module"})
    await s("module", {"action": "delete", "project_id": P, "module_id": "$module"})

    # Intake
    await s(
        "intake",
        {"action": "create", "project_id": P, "name": "Customer asks for SSO"},
        {"intake": lambda d: d.get("issue") or d.get("issue_detail", {}).get("id") or d["id"]},
    )
    await s("intake", {"action": "list", "project_id": P})
    await s("intake", {"action": "retrieve", "project_id": P, "workitem_id": "$intake"})
    await s("intake", {"action": "update", "project_id": P, "workitem_id": "$intake", "status": 1})
    await s("intake", {"action": "create", "project_id": P, "name": "Spam"}, {"intake2": lambda d: d.get("issue") or d["id"]})
    await s("intake", {"action": "delete", "project_id": P, "workitem_id": "$intake2"})

    # Estimates
    await s("project_estimate", {"action": "create", "project_id": P, "name": "Points", "type": "points"}, {"est": "id"})
    await s("project_estimate", {"action": "retrieve", "project_id": P})
    await s("project_estimate", {"action": "update", "project_id": P, "description": "story points"})
    await s(
        "project_estimate",
        {
            "action": "create_points",
            "project_id": P,
            "estimate_id": "$est",
            "points": '[{"value": "1", "key": 1}, {"value": "3", "key": 2}]',
        },
    )
    await s("project_estimate", {"action": "list_points", "project_id": P, "estimate_id": "$est"}, {"point": first})
    await s(
        "project_estimate",
        {"action": "update_point", "project_id": P, "estimate_id": "$est", "estimate_point_id": "$point", "value": "2"},
    )
    await s("project_estimate", {"action": "link", "project_id": P, "estimate_id": "$est"})
    await s(
        "project_estimate",
        {"action": "delete_point", "project_id": P, "estimate_id": "$est", "estimate_point_id": "$point"},
    )

    # Work item types and custom properties
    await s("workitem_type", {"action": "create", "name": f"Epic {SUFFIX}", "description": "big"}, {"wtype": "id"})
    await s("workitem_type", {"action": "list"})
    await s("workitem_type", {"action": "import_to_project", "project_id": P, "workitem_type_ids": "$wtype"})
    await s("workitem_type", {"action": "list", "project_id": P})
    await s("workitem_type", {"action": "resolve", "project_id": P, "name": f"Epic {SUFFIX}"})
    await s("workitem_type", {"action": "retrieve", "workitem_type_id": "$wtype"})
    await s("workitem_type", {"action": "update", "workitem_type_id": "$wtype", "description": "bigger"})
    await s("workitem", {"action": "update", "project_id": P, "workitem_id": "$w1", "type_id": "$wtype"})
    await s(
        "workitem_property",
        {
            "action": "create",
            "display_name": f"Tier {SUFFIX}",
            "property_type": "OPTION",
            "workitem_type_id": "$wtype",
            "options": '[{"name": "Gold", "color": "#EAB308"}]',
        },
        {"prop": "id"},
    )
    await s("workitem_property", {"action": "list", "workitem_type_id": "$wtype"})
    await s("workitem_property", {"action": "retrieve", "workitem_property_id": "$prop", "workitem_type_id": "$wtype"})
    await s(
        "workitem_property",
        {"action": "update", "workitem_property_id": "$prop", "workitem_type_id": "$wtype", "description": "account tier"},
    )
    await s("workitem_property", {"action": "manage_type_properties", "workitem_type_id": "$wtype", "attach_ids": "$prop"})
    await s("workitem_property", {"action": "create_option", "property_id": "$prop", "name": "Silver"}, {"option": "id"})
    await s("workitem_property", {"action": "list_options", "property_id": "$prop"})
    await s("workitem_property", {"action": "retrieve_option", "property_id": "$prop", "option_id": "$option"})
    await s("workitem_property", {"action": "update_option", "property_id": "$prop", "option_id": "$option", "color": "#9CA3AF"})
    await s("workitem_property", {"action": "set_value", **W, "property_id": "$prop", "value": "$option"})
    await s("workitem_property", {"action": "get_value", **W, "property_id": "$prop"})
    V["cf_pql"] = f'cf["{V.get("prop")}"] = "{V.get("option")}"'
    await s("workitem", {"action": "list", "project_id": P, "pql": "$cf_pql"})
    await s("workitem_property", {"action": "delete_value", **W, "property_id": "$prop"})
    await s("workitem_property", {"action": "delete_option", "property_id": "$prop", "option_id": "$option"})
    await s("workitem_property", {"action": "manage_type_properties", "workitem_type_id": "$wtype", "detach_ids": "$prop"})
    await s("workitem_property", {"action": "delete", "workitem_property_id": "$prop", "workitem_type_id": "$wtype"})

    # Templates
    await s(
        "template",
        {"action": "create", "kind": "workitem", "name": "Bug", "template_data": '{"name": "Bug", "priority": "high"}'},
        {"template": "id"},
    )
    await s("template", {"action": "list", "kind": "workitem"})
    await s("template", {"action": "update", "kind": "workitem", "template_id": "$template", "name": "Bug report"})
    await s("template", {"action": "delete", "kind": "workitem", "template_id": "$template"})

    # Customers
    await s(
        "customer_property",
        {"action": "create", "display_name": f"Plan {SUFFIX}", "property_type": "TEXT", "display_format": "single-line"},
        {"cprop": "id"},
    )
    await s("customer_property", {"action": "list"})
    await s("customer_property", {"action": "retrieve", "property_id": "$cprop"})
    await s("customer_property", {"action": "update", "property_id": "$cprop", "description": "billing plan"})
    await s(
        "customer",
        {"action": "create", "name": f"Acme {SUFFIX}", "email": "ops@acme.example", "domain": "acme.example"},
        {"customer": "id"},
    )
    await s("customer", {"action": "list"})
    await s("customer", {"action": "retrieve", "customer_id": "$customer"})
    await s("customer", {"action": "update", "customer_id": "$customer", "employees": 120})
    await s("customer_property", {"action": "get_values", "customer_id": "$customer"})
    V["cvalues"] = json.dumps({V.get("cprop"): ["Enterprise"]})
    await s("customer_property", {"action": "set_values", "customer_id": "$customer", "values": "$cvalues"})
    await s("customer_property", {"action": "get_values", "customer_id": "$customer", "property_id": "$cprop"})
    await s("customer", {"action": "manage_workitems", "customer_id": "$customer", "link_ids": "$w1"})
    await s("customer", {"action": "list_workitems", "customer_id": "$customer"})
    await s(
        "customer_request",
        {"action": "create", "customer_id": "$customer", "name": "SSO", "workitem_ids": "$w2"},
        {"creq": "id"},
    )
    await s("customer_request", {"action": "list", "customer_id": "$customer"})
    await s("customer_request", {"action": "retrieve", "customer_id": "$customer", "request_id": "$creq"})
    await s("customer_request", {"action": "update", "customer_id": "$customer", "request_id": "$creq", "link": "https://x.example"})
    await s("customer_request", {"action": "delete", "customer_id": "$customer", "request_id": "$creq"})
    await s("customer", {"action": "manage_workitems", "customer_id": "$customer", "unlink_ids": "$w1"})
    await s("customer", {"action": "delete", "customer_id": "$customer"})
    await s("customer_property", {"action": "delete", "property_id": "$cprop"})

    # Releases
    await s("release_tag", {"action": "create", "version": f"v1.0.{random.randint(0, 999)}"}, {"tag": "id"})
    await s("release_tag", {"action": "list"})
    await s("release_tag", {"action": "retrieve", "tag_id": "$tag"})
    await s("release_tag", {"action": "update", "tag_id": "$tag", "description": "first"})
    await s("release", {"action": "create", "name": f"Launch {SUFFIX}", "tag_id": "$tag", "status": "unreleased"}, {"release": "id"})
    await s("release", {"action": "list"})
    await s("release", {"action": "retrieve", "release_id": "$release"})
    await s("release", {"action": "update", "release_id": "$release", "target_date": end})
    await s("release", {"action": "get_changelog", "release_id": "$release"})
    await s("release", {"action": "update_changelog", "release_id": "$release", "description_html": "<p>notes</p>"})
    await s("release", {"action": "manage_workitems", "release_id": "$release", "add_ids": "$w1"})
    await s("release", {"action": "list_workitems", "release_id": "$release"})
    await s("release_label", {"action": "create", "name": f"major-{SUFFIX}", "color": "#F97316"}, {"rlabel": "id"})
    await s("release_label", {"action": "list"})
    await s("release_label", {"action": "update", "label_id": "$rlabel", "name": f"breaking-{SUFFIX}"})
    await s("release_label", {"action": "attach", "release_id": "$release", "label_ids": "$rlabel"})
    await s("release_label", {"action": "list", "release_id": "$release"})
    await s("release_label", {"action": "detach", "release_id": "$release", "label_ids": "$rlabel"})
    await s("release_label", {"action": "delete", "label_id": "$rlabel"})
    await s("release", {"action": "manage_workitems", "release_id": "$release", "remove_ids": "$w1"})
    await s("release", {"action": "delete", "release_id": "$release"})
    await s("release_tag", {"action": "delete", "tag_id": "$tag"})

    # Milestones
    await s("milestone", {"action": "create", "project_id": P, "title": "Beta", "target_date": end}, {"milestone": "id"})
    await s("milestone", {"action": "list", "project_id": P})
    await s("milestone", {"action": "retrieve", "project_id": P, "milestone_id": "$milestone"})
    await s("milestone", {"action": "update", "project_id": P, "milestone_id": "$milestone", "title": "Public beta"})
    await s("milestone", {"action": "manage_workitems", "project_id": P, "milestone_id": "$milestone", "add_ids": "$w1"})
    await s("milestone", {"action": "list_workitems", "project_id": P, "milestone_id": "$milestone"})
    await s("milestone", {"action": "delete", "project_id": P, "milestone_id": "$milestone"})

    # Initiatives
    await s("initiative", {"action": "create", "name": f"Grow {SUFFIX}", "lead": "$me"}, {"initiative": "id"})
    await s("initiative", {"action": "list"})
    await s("initiative", {"action": "retrieve", "initiative_id": "$initiative"})
    await s("initiative", {"action": "update", "initiative_id": "$initiative", "end_date": later_end})
    await s("initiative", {"action": "add_projects", "initiative_id": "$initiative", "project_ids": P})
    await s("initiative", {"action": "list_projects", "initiative_id": "$initiative"})
    await s("initiative", {"action": "manage_workitems", "initiative_id": "$initiative", "add_ids": "$w1"})
    await s("initiative", {"action": "list_workitems", "initiative_id": "$initiative"})
    await s("initiative", {"action": "remove_projects", "initiative_id": "$initiative", "project_ids": P})
    await s("initiative", {"action": "delete", "initiative_id": "$initiative"})

    # Pages and collections
    await s(
        "page",
        {"action": "create", "project_id": P, "name": "Runbook", "description_html": "<p>Step one</p>"},
        {"page": "id"},
    )
    await s("page", {"action": "list", "project_id": P})
    await s("page", {"action": "retrieve", "project_id": P, "page_id": "$page"})
    await s("page", {"action": "update", "project_id": P, "page_id": "$page", "description_html": "<p>Step two</p>"})
    await s("page", {"action": "attach_to_workitem", **W, "page_id": "$page"}, {"wipage": "id"})
    await s("page", {"action": "list_workitem_pages", **W})
    await s("page", {"action": "detach_from_workitem", **W, "workitem_page_id": "$wipage"})
    await s("page", {"action": "create", "name": "Handbook", "description_html": "<p>Welcome</p>"}, {"wpage": "id"})
    await s("page", {"action": "list"})
    await s("collection", {"action": "create", "name": f"Docs {SUFFIX}"}, {"collection": "id"})
    await s("collection", {"action": "list"})
    await s("collection", {"action": "retrieve", "collection_id": "$collection"})
    await s("collection", {"action": "update", "collection_id": "$collection", "name": f"Docs {SUFFIX} v2"})
    await s("collection", {"action": "add_pages", "collection_id": "$collection", "page_ids": "$wpage"})
    await s("collection", {"action": "list_pages", "collection_id": "$collection"}, {"pagecol": lambda d: first(d, "page_collection_id")})
    await s("collection", {"action": "search_pages", "collection_id": "$collection", "search": "Hand"})
    await s("collection", {"action": "remove_page", "collection_id": "$collection", "page_collection_id": "$pagecol"})
    await s("page", {"action": "set_collection", "page_id": "$wpage", "collection_id": "$collection"})
    await s("collection", {"action": "list_members", "collection_id": "$collection"})
    await s(
        "collection",
        {"action": "add_member", "collection_id": "$collection", "user_id": "$teammate", "member_access": "edit"},
        {"cmember": "id"},
    )
    await s(
        "collection",
        {"action": "update_member", "collection_id": "$collection", "collection_member_id": "$cmember", "member_access": "view"},
    )
    await s("collection", {"action": "remove_member", "collection_id": "$collection", "collection_member_id": "$cmember"})
    await s("collection", {"action": "delete", "collection_id": "$collection"})
    await s("page", {"action": "archive", "project_id": P, "page_id": "$page"})
    await s("page", {"action": "archive", "project_id": P, "page_id": "$page", "archive": False})
    await s("page", {"action": "delete", "project_id": P, "page_id": "$page"}, expect_error="archived before")
    await s("page", {"action": "archive", "project_id": P, "page_id": "$page"})
    await s("page", {"action": "delete", "project_id": P, "page_id": "$page"})
    await s("page", {"action": "archive", "page_id": "$wpage"})
    await s("page", {"action": "delete", "page_id": "$wpage"})

    # Archive a work item: it must be in a completed state first
    await s("workitem", {"action": "update", "project_id": P, "workitem_id": "$w2", "state": "$done_state"})
    await s("workitem", {"action": "archive", "project_id": P, "workitem_id": "$w2"})
    await s("workitem", {"action": "list_archived", "project_id": P})
    await s("workitem", {"action": "archive", "project_id": P, "workitem_id": "$w2", "archive": False})

    # Cleanup
    await s("project_estimate", {"action": "delete", "project_id": P})
    await s("workitem_type", {"action": "delete", "workitem_type_id": "$wtype"}, expect_error="use the type")
    await s("workitem", {"action": "delete", "project_id": P, "workitem_id": "$w1"})
    await s("workitem", {"action": "delete", "project_id": P, "workitem_id": "$w2"})
    await s("workitem_type", {"action": "delete", "workitem_type_id": "$wtype"})
    await s("label", {"action": "delete", "project_id": P, "label_id": "$label"})
    await s("state", {"action": "delete", "project_id": P, "state_id": "$state"})
    await s("project", {"action": "archive", "project_id": P})
    await s("project", {"action": "unarchive", "project_id": P})
    await s("project", {"action": "delete", "project_id": P})


async def main() -> int:
    url = os.environ.get("MCP_URL", "http://localhost:8211/mcp")
    headers = {"Authorization": f"Bearer {os.environ['PLANE_PAT']}", "X-Workspace-slug": os.environ["PLANE_WORKSPACE"]}
    async with Client(StreamableHttpTransport(url, headers=headers), timeout=120) as client:
        tools = await client.list_tools()
        await scenario(client)

    declared = {f"{t.name}.{a}" for t in tools for a in (t.inputSchema["properties"].get("action", {}).get("enum") or ["read"])}
    ran = {name for name, _, _ in RESULTS}
    failed = [r for r in RESULTS if r[1] == "FAIL"]
    for name, status, detail in RESULTS:
        print(f"{status:8} {name}" + (f"\n         {detail}" if status == "FAIL" else ""))
    print(f"\n{len(tools)} tools, {len(declared)} actions declared; {len(ran & declared)} exercised; "
          f"{sum(r[1] != 'FAIL' for r in RESULTS)} passed, {len(failed)} failed")
    missing = sorted(declared - ran)
    if missing:
        print("not exercised:", ", ".join(missing))
    return 1 if failed or missing else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
