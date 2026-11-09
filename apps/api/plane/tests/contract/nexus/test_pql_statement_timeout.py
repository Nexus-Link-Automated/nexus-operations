# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A PQL query that runs past the statement limit is answered like any other PQL error."""

from uuid import uuid4

import pytest
from django.db import connection
from django.db.models import BooleanField, Q
from django.db.models.expressions import RawSQL
from django.test.utils import CaptureQueriesContext

from plane.api.views import issue as issue_views
from plane.db.models import Cycle, Issue, Module
from plane.nexus.pql import register_custom_property_filter

LIMIT_MS = 50
SLEEP_SECONDS = 0.25

ROUTES = ["project", "cycle", "module", "workspace", "count", "archived", "release", "milestone", "initiative"]


@pytest.fixture
def items(project, create_user):
    return [Issue.objects.create(name="One", project=project, created_by=create_user)]


@pytest.fixture
def slow_pql():
    """A cf[...] condition whose SQL sleeps: a stand-in for a scan that outruns the limit."""
    sleep = RawSQL(f"(SELECT true FROM pg_sleep({SLEEP_SECONDS}))", [], output_field=BooleanField())
    register_custom_property_filter(lambda *args: Q(sleep))
    yield f'cf["{uuid4()}"] = "x"'
    register_custom_property_filter(None)


@pytest.fixture
def slow_statement(monkeypatch):
    """The project list calls apply_pql with or without a query; make that call slow."""
    real = issue_views.apply_pql

    def slow(queryset, pql, **kwargs):
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_sleep(%s)", [SLEEP_SECONDS])
        return real(queryset, pql, **kwargs)

    monkeypatch.setattr(issue_views, "apply_pql", slow)


def _url(name, client, ws_url, project_url, project, create_user):
    if name == "project":
        return project_url("work-items/")
    if name == "cycle":
        cycle = Cycle.objects.create(name="C", project=project, owned_by=create_user)
        return project_url(f"cycles/{cycle.id}/cycle-issues/")
    if name == "module":
        module = Module.objects.create(name="M", project=project)
        return project_url(f"modules/{module.id}/module-issues/")
    if name == "workspace":
        return ws_url("work-items/")
    if name == "count":
        return ws_url("work-items/count/")
    if name == "archived":
        return project_url("archived-work-items/")
    if name == "release":
        rid = client.post(ws_url("releases/"), {"name": "v1"}, format="json").data["id"]
        return ws_url(f"releases/{rid}/work-items/")
    if name == "milestone":
        mid = client.post(project_url("milestones/"), {"title": "M1"}, format="json").data["id"]
        return project_url(f"milestones/{mid}/work-items/")
    iid = client.post(ws_url("initiatives/"), {"name": "Grow"}, format="json").data["id"]
    return ws_url(f"initiatives/{iid}/work-items/")


@pytest.mark.contract
class TestPQLStatementTimeout:
    @pytest.mark.parametrize("route", ROUTES)
    def test_a_query_past_the_limit_is_a_pql_400(
        self, client, ws_url, project_url, project, create_user, items, settings, slow_pql, route
    ):
        url = _url(route, client, ws_url, project_url, project, create_user)
        settings.PQL_STATEMENT_TIMEOUT_MS = LIMIT_MS
        res = client.get(url, {"pql": slow_pql})
        assert res.status_code == 400, res.data
        assert res.data["pql"] == [res.data["error"]] and "too long" in res.data["error"]

    def test_a_request_is_usable_again_after_a_timeout(self, client, project_url, items, settings, slow_pql):
        settings.PQL_STATEMENT_TIMEOUT_MS = LIMIT_MS
        assert client.get(project_url("work-items/"), {"pql": slow_pql}).status_code == 400
        assert client.get(project_url("work-items/")).status_code == 200

    @pytest.mark.parametrize("params", [{}, {"pql": "   "}], ids=["absent", "blank"])
    def test_a_slow_request_without_pql_is_not_limited(
        self, client, project_url, items, settings, slow_statement, params
    ):
        settings.PQL_STATEMENT_TIMEOUT_MS = LIMIT_MS
        with CaptureQueriesContext(connection) as queries:
            res = client.get(project_url("work-items/"), params)
        assert res.status_code == 200, res.data
        assert len(res.data["results"]) == 1
        assert not any("statement_timeout" in query["sql"] for query in queries)

    def test_the_same_slow_statement_is_cut_short_with_pql(self, client, project_url, items, settings, slow_statement):
        settings.PQL_STATEMENT_TIMEOUT_MS = LIMIT_MS
        res = client.get(project_url("work-items/"), {"pql": 'priority = "none"'})
        assert res.status_code == 400 and "too long" in res.data["error"]

    def test_zero_turns_the_limit_off(self, client, project_url, items, settings, slow_pql):
        settings.PQL_STATEMENT_TIMEOUT_MS = 0
        res = client.get(project_url("work-items/"), {"pql": slow_pql})
        assert res.status_code == 200, res.data

    def test_a_query_inside_the_limit_is_answered(self, client, project_url, items, settings):
        settings.PQL_STATEMENT_TIMEOUT_MS = 30000
        res = client.get(project_url("work-items/"), {"pql": 'priority = "none"'})
        assert res.status_code == 200, res.data
        assert [row["name"] for row in res.data["results"]] == ["One"]


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
def test_the_limit_ends_with_the_request(client, project_url, items, settings):
    def server_setting():
        with connection.cursor() as cursor:
            cursor.execute("SHOW statement_timeout")
            return cursor.fetchone()[0]

    before = server_setting()
    settings.PQL_STATEMENT_TIMEOUT_MS = 30000
    assert client.get(project_url("work-items/"), {"pql": 'priority = "none"'}).status_code == 200
    assert server_setting() == before != "30s"
