# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import re
from urllib.parse import urlsplit

from django.core.validators import URLValidator
from rest_framework import serializers

from plane.coding.columns import Column, resolve_columns
from plane.coding.serializers.base import StrictSerializer
from plane.db.models import State

DEFAULT_BRANCH = "main"

# A plain branch name: letters, digits, ".", "_", "-" and "/" only, within git's own rules. Narrower than git allows,
# because the name travels to the machines that run jobs; nothing there should have to quote it.
_BRANCH = re.compile(r"^(?![.\-/])(?!.*//)(?!.*\.\.)(?!.*/\.)(?!.*\.lock$)(?!.*/$)(?!.*\.$)[A-Za-z0-9._/-]+$")

_STATE_FIELDS = {Column.READY: "ready_state", Column.FAILED: "failed_state", Column.IN_REVIEW: "in_review_state"}


def settings_payload(project, coding_settings) -> dict:
    """The settings as the API returns them, with defaults for a project that has none yet.

    `columns` says which state each outcome column resolves to right now, and whether the project chose it or it
    was matched by name; null when neither found one.
    """
    columns = {}
    for key, (state, chosen) in resolve_columns(project.id, coding_settings).items():
        columns[key] = {"id": str(state.id), "name": state.name, "chosen": chosen} if state else None
    payload = {
        "project": str(project.id),
        "enabled": False,
        "repo_url": "",
        "default_branch": DEFAULT_BRANCH,
        "configured": False,
        "columns": columns,
        "updated_at": None,
    }
    for field in _STATE_FIELDS.values():
        payload[field] = None
    if coding_settings is not None:
        payload.update(
            enabled=coding_settings.enabled,
            repo_url=coding_settings.repo_url,
            default_branch=coding_settings.default_branch,
            configured=coding_settings.is_configured,
            updated_at=coding_settings.updated_at,
        )
        for field in _STATE_FIELDS.values():
            value = getattr(coding_settings, f"{field}_id")
            payload[field] = str(value) if value else None
    return payload


class ProjectCodingSettingsUpdateSerializer(StrictSerializer):
    enabled = serializers.BooleanField(required=False)
    repo_url = serializers.CharField(max_length=500, required=False, allow_blank=True)
    default_branch = serializers.CharField(max_length=255, required=False)
    ready_state = serializers.UUIDField(required=False, allow_null=True)
    failed_state = serializers.UUIDField(required=False, allow_null=True)
    in_review_state = serializers.UUIDField(required=False, allow_null=True)

    def validate_repo_url(self, value):
        if value:
            URLValidator(schemes=["https"], message="Enter the repository's https URL.")(value)
            # Members can read the settings, so no credentials in the URL; access comes from elsewhere.
            if "@" in urlsplit(value).netloc:
                raise serializers.ValidationError("Leave credentials out of the repository URL.")
        return value

    def validate_default_branch(self, value):
        if not _BRANCH.match(value):
            raise serializers.ValidationError("Not a valid branch name.")
        return value

    def validate(self, attrs):
        project = self.context["project"]
        errors = {}
        for field in _STATE_FIELDS.values():
            state_id = attrs.get(field)
            if state_id is None:
                continue
            # State.objects leaves out deleted and triage states.
            state = State.objects.filter(pk=state_id, project=project).first()
            if state is None:
                errors[field] = ["Choose a state of this project."]
            else:
                attrs[field] = state
        if errors:
            raise serializers.ValidationError(errors)
        return attrs
