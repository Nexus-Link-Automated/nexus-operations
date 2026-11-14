# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

PROJECT = "workspaces/<str:slug>/projects/<uuid:project_id>/"
JOBS = PROJECT + "work-items/<uuid:issue_id>/coding-jobs/"
JOB = JOBS + "<uuid:job_id>/"


def routes(views: dict, prefix: str) -> list:
    """The same paths for either mount; `views` maps each route to its endpoint class."""
    return [
        path(JOBS, views["list"].as_view(http_method_names=["get", "post"]), name=f"{prefix}-coding-jobs"),
        path(JOB, views["detail"].as_view(http_method_names=["get"]), name=f"{prefix}-coding-job"),
        path(JOB + "cancel/", views["cancel"].as_view(http_method_names=["post"]), name=f"{prefix}-coding-job-cancel"),
        path(JOB + "retry/", views["retry"].as_view(http_method_names=["post"]), name=f"{prefix}-coding-job-retry"),
        path(
            PROJECT + "coding-settings/",
            views["settings"].as_view(http_method_names=["get", "patch"]),
            name=f"{prefix}-coding-settings",
        ),
    ]
