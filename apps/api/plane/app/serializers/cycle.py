# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import serializers

# Module imports
from .base import BaseSerializer
from .issue import IssueStateSerializer
from plane.db.models import Cycle, CycleIssue, CycleUserProperties
from plane.utils.timezone_converter import convert_to_utc


class CycleWriteSerializer(BaseSerializer):
    def validate(self, data):
        project_id = (
            self.initial_data.get("project_id", None)
            or (self.instance and self.instance.project_id)
            or self.context.get("project_id", None)
        )
        # Each date is placed in the project's timezone, including one sent on its own.
        if data.get("start_date", None) is not None:
            data["start_date"] = convert_to_utc(
                date=str(data.get("start_date").date()),
                project_id=project_id,
                is_start_date=True,
            )
        if data.get("end_date", None) is not None:
            data["end_date"] = convert_to_utc(
                date=str(data.get("end_date", None).date()),
                project_id=project_id,
            )
        # Compare with the stored value of a date that is not sent. Only checked when a
        # date changes, so rows already out of order can still be edited otherwise.
        start_date = data.get("start_date", getattr(self.instance, "start_date", None))
        end_date = data.get("end_date", getattr(self.instance, "end_date", None))
        dates_changed = "start_date" in data or "end_date" in data
        if dates_changed and start_date is not None and end_date is not None and start_date > end_date:
            raise serializers.ValidationError("Start date cannot exceed end date")
        return data

    class Meta:
        model = Cycle
        fields = "__all__"
        # Audit fields are set server-side by BaseModel.save().
        read_only_fields = [
            "workspace",
            "project",
            "owned_by",
            "archived_at",
            "created_by",
            "updated_by",
        ]


class CycleSerializer(BaseSerializer):
    # favorite
    is_favorite = serializers.BooleanField(read_only=True)
    total_issues = serializers.IntegerField(read_only=True)
    # state group wise distribution
    cancelled_issues = serializers.IntegerField(read_only=True)
    completed_issues = serializers.IntegerField(read_only=True)
    started_issues = serializers.IntegerField(read_only=True)
    unstarted_issues = serializers.IntegerField(read_only=True)
    backlog_issues = serializers.IntegerField(read_only=True)

    # active | draft | upcoming | completed
    status = serializers.CharField(read_only=True)

    class Meta:
        model = Cycle
        fields = [
            # necessary fields
            "id",
            "workspace_id",
            "project_id",
            # model fields
            "name",
            "description",
            "start_date",
            "end_date",
            "owned_by_id",
            "view_props",
            "sort_order",
            "external_source",
            "external_id",
            "progress_snapshot",
            "logo_props",
            # meta fields
            "is_favorite",
            "total_issues",
            "cancelled_issues",
            "completed_issues",
            "started_issues",
            "unstarted_issues",
            "backlog_issues",
            "status",
        ]
        read_only_fields = fields


class CycleIssueSerializer(BaseSerializer):
    issue_detail = IssueStateSerializer(read_only=True, source="issue")
    sub_issues_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = CycleIssue
        fields = "__all__"
        read_only_fields = ["workspace", "project", "cycle"]


class CycleUserPropertiesSerializer(BaseSerializer):
    class Meta:
        model = CycleUserProperties
        fields = "__all__"
        read_only_fields = ["workspace", "project", "cycle", "user"]
