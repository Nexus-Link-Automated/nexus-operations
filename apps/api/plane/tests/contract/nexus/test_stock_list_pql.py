# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""PQL on the stock project, cycle and module work-item lists, which the MCP sends `pql` to."""

import pytest

from django.utils import timezone

from plane.db.models import Cycle, CycleIssue, Intake, IntakeIssue, Issue, Module, ModuleIssue, State


@pytest.fixture
def items(project, create_user):
    high = Issue.objects.create(name="High one", priority="high", project=project, created_by=create_user)
    low = Issue.objects.create(name="Low one", priority="low", project=project, created_by=create_user)
    return high, low


def _names(res):
    assert res.status_code == 200, res.data
    return sorted(r["name"] for r in res.data["results"])


@pytest.mark.contract
class TestStockListsHonourPQL:
    def test_project_list(self, client, project_url, items):
        assert _names(client.get(project_url("work-items/"), {"pql": 'priority = "high"'})) == ["High one"]
        assert _names(client.get(project_url("work-items/"))) == ["High one", "Low one"]

    def test_cycle_list(self, client, project_url, project, items, create_user):
        cycle = Cycle.objects.create(name="C", project=project, owned_by=create_user)
        for item in items:
            CycleIssue.objects.create(cycle=cycle, issue=item, project=project)
        res = client.get(project_url(f"cycles/{cycle.id}/cycle-issues/"), {"pql": 'priority = "low"'})
        assert _names(res) == ["Low one"]

    def test_module_list(self, client, project_url, project, items):
        module = Module.objects.create(name="M", project=project)
        for item in items:
            ModuleIssue.objects.create(module=module, issue=item, project=project)
        res = client.get(project_url(f"modules/{module.id}/module-issues/"), {"pql": 'priority = "high"'})
        assert _names(res) == ["High one"]

    def test_invalid_pql_is_a_400_naming_the_problem(self, client, project_url, items):
        res = client.get(project_url("work-items/"), {"pql": "priority === nonsense"})
        assert res.status_code == 400 and res.data["pql"]

    def test_structured_filters_still_refused(self, client, project_url, items):
        assert client.get(project_url("work-items/"), {"filters": "{}"}).status_code == 400


@pytest.fixture
def hidden_items(project, create_user):
    """One visible work item, plus one each of the kinds Plane's default manager hides."""
    triage = State.objects.create(name="Triage", group="triage", project=project)
    open_item = Issue.objects.create(name="Open", project=project, created_by=create_user)
    draft = Issue.objects.create(name="Draft", is_draft=True, project=project, created_by=create_user)
    archived = Issue.objects.create(name="Archived", project=project, created_by=create_user)
    Issue.objects.filter(pk=archived.pk).update(archived_at=timezone.now())
    intake_item = Issue.objects.create(name="Intake", state=triage, project=project, created_by=create_user)
    intake = Intake.objects.create(name="Intake", project=project)
    IntakeIssue.objects.create(intake=intake, issue=intake_item, project=project)
    return [open_item, draft, archived, intake_item]


CONDITIONS = [
    ("isDraft()", "Draft"),
    ("isDraft = true", "Draft"),
    ("isArchived()", "Archived"),
    ("isIntake()", "Intake"),
]


@pytest.mark.contract
class TestStockListsFindWhatPQLAsksFor:
    """These lists started from a scope that hid the very rows these conditions ask about."""

    @pytest.mark.parametrize(("pql", "expected"), CONDITIONS)
    def test_project_list(self, client, project_url, hidden_items, pql, expected):
        res = client.get(project_url("work-items/"), {"pql": pql})
        assert _names(res) == [expected]
        assert res.data["total_count"] == 1

    @pytest.mark.parametrize(("pql", "expected"), CONDITIONS)
    def test_cycle_list(self, client, project_url, project, hidden_items, create_user, pql, expected):
        cycle = Cycle.objects.create(name="C", project=project, owned_by=create_user)
        for item in hidden_items:
            CycleIssue.objects.create(cycle=cycle, issue=item, project=project)
        assert _names(client.get(project_url(f"cycles/{cycle.id}/cycle-issues/"), {"pql": pql})) == [expected]

    @pytest.mark.parametrize(("pql", "expected"), CONDITIONS)
    def test_module_list(self, client, project_url, project, hidden_items, pql, expected):
        module = Module.objects.create(name="M", project=project)
        for item in hidden_items:
            ModuleIssue.objects.create(module=module, issue=item, project=project)
        assert _names(client.get(project_url(f"modules/{module.id}/module-issues/"), {"pql": pql})) == [expected]

    def test_only_the_kind_asked_about_is_widened(self, client, project_url, hidden_items):
        res = client.get(project_url("work-items/"), {"pql": "isDraft = false"})
        assert _names(res) == ["Open"]

    def test_other_queries_and_no_query_keep_the_default_scope(self, client, project_url, hidden_items):
        assert _names(client.get(project_url("work-items/"))) == ["Open"]
        assert _names(client.get(project_url("work-items/"), {"pql": 'priority = "none"'})) == ["Open"]
