# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Public API (personal access tokens), mounted at /api/v1/."""

from django.urls import path

from plane.coding import views

from ._routes import routes

urlpatterns = routes(
    {
        "list": views.CodingJobListAPIEndpoint,
        "detail": views.CodingJobDetailAPIEndpoint,
        "cancel": views.CodingJobCancelAPIEndpoint,
        "retry": views.CodingJobRetryAPIEndpoint,
        "events": views.CodingJobEventsAPIEndpoint,
        "settings": views.ProjectCodingSettingsAPIEndpoint,
        "machines": views.CodingMachineListAPIEndpoint,
        "machines_all": views.CodingMachineAllAPIEndpoint,
        "machine": views.CodingMachineDetailAPIEndpoint,
        "machine_approve": views.CodingMachineApproveAPIEndpoint,
        "machine_revoke": views.CodingMachineRevokeAPIEndpoint,
    },
    prefix="api",
)

# The machine's own endpoints: authenticated by the machine's key, so they exist on the public API only.
urlpatterns += [
    path("coding-machines/join/", views.MachineJoinEndpoint.as_view(), name="api-coding-machine-join"),
    path("coding-machines/heartbeat/", views.MachineHeartbeatEndpoint.as_view(), name="api-coding-machine-heartbeat"),
    path(
        "coding-machines/jobs/events/", views.MachineJobEventsEndpoint.as_view(), name="api-coding-machine-job-events"
    ),
    path(
        "coding-machines/jobs/<uuid:job_id>/result/",
        views.MachineJobResultEndpoint.as_view(),
        name="api-coding-machine-job-result",
    ),
]
