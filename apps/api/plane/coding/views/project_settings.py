# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A project's coding settings: members and admins read them, project admins change them."""

from django.db import transaction
from rest_framework.response import Response

from plane.coding.models import ProjectCodingSettings
from plane.coding.serializers import ProjectCodingSettingsUpdateSerializer, settings_payload

from .base import CodingEndpointMixin


class ProjectCodingSettingsMixin(CodingEndpointMixin):
    def get(self, request, slug, project_id):
        self.access.require_reader_of_settings()
        project = self.access.project
        return Response(settings_payload(project, ProjectCodingSettings.objects.filter(project=project).first()))

    def patch(self, request, slug, project_id):
        """Change only the fields sent. A state field takes a state id of this project, or null to match by name."""
        self.access.require_admin()
        project = self.access.project
        serializer = ProjectCodingSettingsUpdateSerializer(
            data=request.data, partial=True, context={"project": project}
        )
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        with transaction.atomic():
            coding_settings, _ = ProjectCodingSettings.objects.select_for_update().get_or_create(project=project)
            for field, value in serializer.validated_data.items():
                setattr(coding_settings, field, value)
            coding_settings.save()
        return Response(settings_payload(project, coding_settings))
