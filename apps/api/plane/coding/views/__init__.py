# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every coding endpoint twice: `...APIEndpoint` for the public API, `...AppEndpoint` for the web app."""

from plane.api.views.base import BaseAPIView as PublicBaseAPIView
from plane.app.views.base import BaseAPIView as AppBaseAPIView

from .job import CodingJobCancelMixin, CodingJobDetailMixin, CodingJobListMixin, CodingJobRetryMixin
from .project_settings import ProjectCodingSettingsMixin


class CodingJobListAPIEndpoint(CodingJobListMixin, PublicBaseAPIView):
    pass


class CodingJobDetailAPIEndpoint(CodingJobDetailMixin, PublicBaseAPIView):
    pass


class CodingJobCancelAPIEndpoint(CodingJobCancelMixin, PublicBaseAPIView):
    pass


class CodingJobRetryAPIEndpoint(CodingJobRetryMixin, PublicBaseAPIView):
    pass


class ProjectCodingSettingsAPIEndpoint(ProjectCodingSettingsMixin, PublicBaseAPIView):
    pass


class CodingJobListAppEndpoint(CodingJobListMixin, AppBaseAPIView):
    pass


class CodingJobDetailAppEndpoint(CodingJobDetailMixin, AppBaseAPIView):
    pass


class CodingJobCancelAppEndpoint(CodingJobCancelMixin, AppBaseAPIView):
    pass


class CodingJobRetryAppEndpoint(CodingJobRetryMixin, AppBaseAPIView):
    pass


class ProjectCodingSettingsAppEndpoint(ProjectCodingSettingsMixin, AppBaseAPIView):
    pass
