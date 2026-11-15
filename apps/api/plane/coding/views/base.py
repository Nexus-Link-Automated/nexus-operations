# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""What every coding endpoint shares, whichever way it is authenticated.

Each endpoint is written once as a mixin and mounted twice (`plane.coding.views`): on the public API, subclassing
`plane.api` `BaseAPIView` like `plane.nexus` (personal access tokens, for MCP and agents), and on the web app's
routes, subclassing `plane.app` `BaseAPIView` (session cookies).
"""

from functools import cached_property

from rest_framework.response import Response

from plane.coding.access import ProjectAccess, project_access
from plane.coding.exceptions import CodingError
from plane.utils.permissions import WorkspaceUserPermission


class CodingEndpointMixin:
    # Active members of the workspace in the URL; everything finer is `plane.coding.access`.
    permission_classes = [WorkspaceUserPermission]

    @cached_property
    def access(self) -> ProjectAccess:
        return project_access(self.request.user, self.kwargs["slug"], self.kwargs["project_id"])

    def handle_exception(self, exc):
        if isinstance(exc, CodingError):
            return Response(exc.body(), status=exc.http_status)
        return super().handle_exception(exc)

    @staticmethod
    def invalid(errors) -> Response:
        return Response({"error": "The request is not valid.", "errors": errors}, status=400)
