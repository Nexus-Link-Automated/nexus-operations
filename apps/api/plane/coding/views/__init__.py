# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every coding endpoint twice: `...APIEndpoint` for the public API, `...AppEndpoint` for the web app."""

from plane.api.views.base import BaseAPIView as PublicBaseAPIView
from plane.app.views.base import BaseAPIView as AppBaseAPIView

from .job import (
    CodingJobCancelMixin,
    CodingJobDetailMixin,
    CodingJobEventsMixin,
    CodingJobListMixin,
    CodingJobRetryMixin,
)
from .machine import (
    CodingMachineAllMixin,
    CodingMachineApproveMixin,
    CodingMachineDetailMixin,
    CodingMachineListMixin,
    CodingMachineRevokeMixin,
    MachineHeartbeatEndpoint,
    MachineJobEventsEndpoint,
    MachineJobResultEndpoint,
    MachineJoinEndpoint,
)
from .project_settings import ProjectCodingSettingsMixin

__all__ = [
    "MachineHeartbeatEndpoint",
    "MachineJobEventsEndpoint",
    "MachineJobResultEndpoint",
    "MachineJoinEndpoint",
]


class CodingJobListAPIEndpoint(CodingJobListMixin, PublicBaseAPIView):
    pass


class CodingJobDetailAPIEndpoint(CodingJobDetailMixin, PublicBaseAPIView):
    pass


class CodingJobCancelAPIEndpoint(CodingJobCancelMixin, PublicBaseAPIView):
    pass


class CodingJobRetryAPIEndpoint(CodingJobRetryMixin, PublicBaseAPIView):
    pass


class CodingJobEventsAPIEndpoint(CodingJobEventsMixin, PublicBaseAPIView):
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


class CodingJobEventsAppEndpoint(CodingJobEventsMixin, AppBaseAPIView):
    pass


class ProjectCodingSettingsAppEndpoint(ProjectCodingSettingsMixin, AppBaseAPIView):
    pass


class CodingMachineListAPIEndpoint(CodingMachineListMixin, PublicBaseAPIView):
    pass


class CodingMachineAllAPIEndpoint(CodingMachineAllMixin, PublicBaseAPIView):
    pass


class CodingMachineDetailAPIEndpoint(CodingMachineDetailMixin, PublicBaseAPIView):
    pass


class CodingMachineApproveAPIEndpoint(CodingMachineApproveMixin, PublicBaseAPIView):
    pass


class CodingMachineRevokeAPIEndpoint(CodingMachineRevokeMixin, PublicBaseAPIView):
    pass


class CodingMachineListAppEndpoint(CodingMachineListMixin, AppBaseAPIView):
    pass


class CodingMachineAllAppEndpoint(CodingMachineAllMixin, AppBaseAPIView):
    pass


class CodingMachineDetailAppEndpoint(CodingMachineDetailMixin, AppBaseAPIView):
    pass


class CodingMachineApproveAppEndpoint(CodingMachineApproveMixin, AppBaseAPIView):
    pass


class CodingMachineRevokeAppEndpoint(CodingMachineRevokeMixin, AppBaseAPIView):
    pass
