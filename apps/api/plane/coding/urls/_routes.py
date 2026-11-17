# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path

PROJECT = "workspaces/<str:slug>/projects/<uuid:project_id>/"
JOBS = PROJECT + "work-items/<uuid:issue_id>/coding-jobs/"
JOB = JOBS + "<uuid:job_id>/"
MACHINES = "workspaces/<str:slug>/coding-machines/"
MACHINE = MACHINES + "<uuid:machine_id>/"
BOTS = "workspaces/<str:slug>/bot-members/"
BOT = BOTS + "<uuid:bot_id>/"


def routes(views: dict, prefix: str) -> list:
    """The same paths for either mount; `views` maps each route to its endpoint class."""
    return [
        path(JOBS, views["list"].as_view(http_method_names=["get", "post"]), name=f"{prefix}-coding-jobs"),
        path(JOB, views["detail"].as_view(http_method_names=["get"]), name=f"{prefix}-coding-job"),
        path(JOB + "cancel/", views["cancel"].as_view(http_method_names=["post"]), name=f"{prefix}-coding-job-cancel"),
        path(JOB + "events/", views["events"].as_view(http_method_names=["get"]), name=f"{prefix}-coding-job-events"),
        path(JOB + "retry/", views["retry"].as_view(http_method_names=["post"]), name=f"{prefix}-coding-job-retry"),
        path(JOB + "answer/", views["answer"].as_view(http_method_names=["post"]), name=f"{prefix}-coding-job-answer"),
        path(
            PROJECT + "coding-settings/",
            views["settings"].as_view(http_method_names=["get", "patch"]),
            name=f"{prefix}-coding-settings",
        ),
        path(
            PROJECT + "coding-settings/repository/",
            views["repository"].as_view(http_method_names=["get"]),
            name=f"{prefix}-coding-settings-repository",
        ),
        path(MACHINES, views["machines"].as_view(http_method_names=["get", "post"]), name=f"{prefix}-coding-machines"),
        path(
            MACHINES + "all/",
            views["machines_all"].as_view(http_method_names=["get"]),
            name=f"{prefix}-coding-machines-all",
        ),
        path(
            MACHINE,
            views["machine"].as_view(http_method_names=["get", "patch", "delete"]),
            name=f"{prefix}-coding-machine",
        ),
        path(
            MACHINE + "approve/",
            views["machine_approve"].as_view(http_method_names=["post"]),
            name=f"{prefix}-coding-machine-approve",
        ),
        path(
            "workspaces/<str:slug>/coding-audit/",
            views["audit"].as_view(http_method_names=["get"]),
            name=f"{prefix}-coding-audit",
        ),
        path(BOTS, views["bots"].as_view(http_method_names=["get", "post"]), name=f"{prefix}-bot-members"),
        path(BOT, views["bot"].as_view(http_method_names=["get", "patch", "delete"]), name=f"{prefix}-bot-member"),
        path(
            BOT + "token/",
            views["bot_token"].as_view(http_method_names=["post"]),
            name=f"{prefix}-bot-member-token",
        ),
        path(
            MACHINE + "revoke/",
            views["machine_revoke"].as_view(http_method_names=["post"]),
            name=f"{prefix}-coding-machine-revoke",
        ),
    ]
