# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Usage telemetry is opt-in and leaves out values that identify the instance.

Only the OTLP exporter is replaced, so nothing leaves the test and the assertions
see exactly what the metrics SDK would have handed to the network.
"""

import uuid
from typing import NamedTuple
from unittest.mock import patch

import pytest
import requests
from django.core.cache import cache
from django.core.management import call_command
from django.test import Client
from django.utils import timezone
from opentelemetry.sdk.metrics.export import MetricExporter, MetricExportResult
from rest_framework import status

from plane.db.models import Workspace
from plane.license.bgtasks.telemetry_metrics import push_instance_metrics
from plane.license.models import Instance, InstanceAdmin

INSTANCE_URL = "/api/instances/"
SIGN_UP_URL = "/api/instances/admins/sign-up/"

PRIVATE_INSTANCE_NAME = "Acme Confidential Instance"
PRIVATE_DOMAIN = "plane.acme-private.example"
PRIVATE_SLUG = "acme-secret-workspace"


class SentPoint(NamedTuple):
    metric: str
    value: int
    attributes: dict
    resource: dict


class RecordingExporter(MetricExporter):
    """Stands in for the OTLP exporter and records every data point it is given."""

    def __init__(self, sent):
        super().__init__()
        self.sent = sent

    def export(self, metrics_data, timeout_millis=10000, **kwargs):
        for resource_metrics in metrics_data.resource_metrics:
            resource = dict(resource_metrics.resource.attributes)
            for scope_metrics in resource_metrics.scope_metrics:
                for metric in scope_metrics.metrics:
                    for point in metric.data.data_points:
                        self.sent.append(SentPoint(metric.name, point.value, dict(point.attributes), resource))
        return MetricExportResult.SUCCESS

    def force_flush(self, timeout_millis=10000):
        return True

    def shutdown(self, timeout_millis=30000, **kwargs):
        pass


def _make_instance(**overrides):
    fields = {
        "instance_name": PRIVATE_INSTANCE_NAME,
        "instance_id": uuid.uuid4().hex,
        "current_version": "1.2.3",
        "latest_version": "1.2.4",
        "last_checked_at": timezone.now(),
        "is_setup_done": True,
    }
    fields.update(overrides)
    return Instance.objects.create(**fields)


@pytest.fixture
def sent():
    """Everything the task tries to send; the real exporter is never built."""
    points = []
    with patch(
        "plane.license.bgtasks.telemetry_metrics._create_otlp_metric_exporter",
        side_effect=lambda: RecordingExporter(points),
    ):
        yield points


@pytest.mark.contract
class TestTelemetryIsOffByDefault:
    @pytest.mark.django_db
    def test_new_instance_defaults_to_off(self):
        assert _make_instance().is_telemetry_enabled is False

    @pytest.mark.django_db
    def test_registering_a_new_instance_leaves_it_off_and_sends_nothing(self, sent):
        Instance.objects.all().delete()

        with (
            patch(
                "plane.license.management.commands.register_instance.requests.get",
                side_effect=requests.ConnectionError,
            ),
            patch("plane.license.management.commands.register_instance.push_instance_metrics") as task,
        ):
            task.delay.side_effect = push_instance_metrics
            call_command("register_instance", "machine-signature")

        assert Instance.objects.get().is_telemetry_enabled is False
        task.delay.assert_called_once()
        assert sent == []

    @pytest.mark.django_db
    def test_scheduled_task_sends_nothing_for_a_default_instance(self, sent):
        _make_instance()

        push_instance_metrics()

        assert sent == []


@pytest.mark.contract
class TestTelemetryPayload:
    @pytest.mark.django_db
    def test_sends_counts_without_identifying_values(self, sent, monkeypatch, create_user):
        monkeypatch.setenv("WEB_URL", f"https://{PRIVATE_DOMAIN}")
        instance = _make_instance(is_telemetry_enabled=True)
        workspace = Workspace.objects.create(name="Acme", slug=PRIVATE_SLUG, owner=create_user)

        push_instance_metrics()

        instance_points = [point for point in sent if point.metric.startswith("plane_instance_")]
        workspace_points = [point for point in sent if point.metric.startswith("plane_workspace_")]
        assert instance_points
        assert workspace_points
        for point in instance_points:
            assert point.attributes == {
                "instance_id": instance.instance_id,
                "current_version": "1.2.3",
                "latest_version": "1.2.4",
                "edition": "PLANE_COMMUNITY",
                "is_verified": "false",
                "is_setup_done": "true",
            }
        for point in workspace_points:
            assert point.attributes == {"workspace_id": str(workspace.id), "instance_id": instance.instance_id}

        workspaces_total = next(point for point in sent if point.metric == "plane_instance_workspaces_total")
        assert workspaces_total.value == Workspace.objects.count()

        everything_sent = repr(sent)
        for private_value in (PRIVATE_INSTANCE_NAME, PRIVATE_DOMAIN, PRIVATE_SLUG):
            assert private_value not in everything_sent


@pytest.mark.contract
class TestAdminToggle:
    @pytest.mark.django_db
    def test_admin_setting_controls_whether_anything_is_sent(self, sent, session_client, create_user):
        instance = _make_instance()
        InstanceAdmin.objects.create(instance=instance, user=create_user, role=20)

        push_instance_metrics()
        assert sent == []

        response = session_client.patch(INSTANCE_URL, {"is_telemetry_enabled": True}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert Instance.objects.get(pk=instance.pk).is_telemetry_enabled is True
        push_instance_metrics()
        assert sent

        sent.clear()
        response = session_client.patch(INSTANCE_URL, {"is_telemetry_enabled": False}, format="json")
        assert response.status_code == status.HTTP_200_OK
        assert Instance.objects.get(pk=instance.pk).is_telemetry_enabled is False
        push_instance_metrics()
        assert sent == []


@pytest.mark.contract
class TestInstanceSetupChoice:
    @pytest.fixture(autouse=True)
    def _clear_auth_throttle(self):
        cache.delete_pattern("throttle_authentication_*")
        yield
        cache.delete_pattern("throttle_authentication_*")

    def _set_up_instance(self, **extra):
        instance = _make_instance(is_setup_done=False)
        response = Client(HTTP_USER_AGENT="pytest").post(
            SIGN_UP_URL,
            {
                "email": "admin@example.com",
                "password": "c0rrect-Horse-battery-Staple!",
                "first_name": "Ada",
                "company_name": "Acme",
                **extra,
            },
        )
        assert response.status_code == status.HTTP_302_FOUND
        assert "general/" in response.url
        return Instance.objects.get(pk=instance.pk)

    @pytest.mark.django_db
    def test_setup_without_a_choice_leaves_telemetry_off(self):
        assert self._set_up_instance().is_telemetry_enabled is False

    @pytest.mark.django_db
    @pytest.mark.parametrize(("submitted", "expected"), [("True", True), ("False", False)])
    def test_setup_stores_the_submitted_choice(self, submitted, expected):
        assert self._set_up_instance(is_telemetry_enabled=submitted).is_telemetry_enabled is expected
