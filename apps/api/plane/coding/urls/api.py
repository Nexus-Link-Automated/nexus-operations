# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Public API (personal access tokens), mounted at /api/v1/."""

from plane.coding import views

from ._routes import routes

urlpatterns = routes(
    {
        "list": views.CodingJobListAPIEndpoint,
        "detail": views.CodingJobDetailAPIEndpoint,
        "cancel": views.CodingJobCancelAPIEndpoint,
        "retry": views.CodingJobRetryAPIEndpoint,
        "settings": views.ProjectCodingSettingsAPIEndpoint,
    },
    prefix="api",
)
