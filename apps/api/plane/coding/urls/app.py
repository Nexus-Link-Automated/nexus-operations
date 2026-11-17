# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The web app's routes (session cookies), mounted at /api/."""

from plane.coding import views

from ._routes import routes

urlpatterns = routes(
    {
        "list": views.CodingJobListAppEndpoint,
        "detail": views.CodingJobDetailAppEndpoint,
        "cancel": views.CodingJobCancelAppEndpoint,
        "retry": views.CodingJobRetryAppEndpoint,
        "events": views.CodingJobEventsAppEndpoint,
        "answer": views.CodingJobAnswerAppEndpoint,
        "settings": views.ProjectCodingSettingsAppEndpoint,
        "repository": views.ProjectCodingRepositoryAppEndpoint,
        "machines": views.CodingMachineListAppEndpoint,
        "machines_all": views.CodingMachineAllAppEndpoint,
        "machine": views.CodingMachineDetailAppEndpoint,
        "machine_approve": views.CodingMachineApproveAppEndpoint,
        "machine_revoke": views.CodingMachineRevokeAppEndpoint,
        "bots": views.BotMemberListAppEndpoint,
        "bot": views.BotMemberDetailAppEndpoint,
        "bot_token": views.BotMemberTokenAppEndpoint,
    },
    prefix="app",
)
