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
        "settings": views.ProjectCodingSettingsAppEndpoint,
    },
    prefix="app",
)
