# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Serializers for the work_item feature group (plane-sdk WorkItemWorkLog, WorkItemWithRelationType)."""

from rest_framework import serializers

from plane.api.serializers import IssueSerializer, LabelSerializer, UserLiteSerializer
from plane.api.serializers.base import BaseSerializer
from plane.db.models import IssueAssignee, IssueLabel, Label, User
from plane.nexus.models import WorkItemWorkLog


class WorkItemWorkLogSerializer(serializers.ModelSerializer):
    """plane-sdk WorkItemWorkLog. duration is in minutes."""

    project_id = serializers.UUIDField(read_only=True)
    workspace_id = serializers.UUIDField(read_only=True)
    issue_id = serializers.UUIDField(read_only=True)
    logged_by = serializers.UUIDField(source="logged_by_id", read_only=True)
    created_by = serializers.UUIDField(source="created_by_id", read_only=True)
    updated_by = serializers.UUIDField(source="updated_by_id", read_only=True)
    description = serializers.CharField(required=False, allow_blank=True, allow_null=True, max_length=10000)
    duration = serializers.IntegerField(min_value=1, max_value=60 * 24 * 365)

    class Meta:
        model = WorkItemWorkLog
        fields = [
            "id",
            "description",
            "duration",
            "logged_by",
            "issue_id",
            "project_id",
            "workspace_id",
            "created_at",
            "updated_at",
            "created_by",
            "updated_by",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_description(self, value):
        return value or ""


class IssuePageSerializer(IssueSerializer):
    """IssueSerializer for a page of work items, with one query per relation for the whole page.

    IssueSerializer runs those queries for every row. Same output: call `load_page`
    with the rows on the list serializer's child before reading `.data`.
    """

    # (field, through model, through column, related model, related serializer, select_related for it)
    _RELATIONS = (
        ("assignees", IssueAssignee, "assignee_id", User, UserLiteSerializer, ("avatar_asset",)),
        ("labels", IssueLabel, "label_id", Label, LabelSerializer, ()),
    )

    def load_page(self, rows) -> None:
        ids = [row.id for row in rows]
        self.related_by_issue = {}
        for field, through, column, model, serializer, joins in self._RELATIONS:
            if field not in self.fields:
                continue
            by_issue: dict = {}
            for issue_id, value in through.objects.filter(issue_id__in=ids).values_list("issue_id", column):
                by_issue.setdefault(issue_id, []).append(value)
            if field in self.expand:
                # Same row order as IssueSerializer: the related model's default ordering.
                queryset = model.objects.filter(pk__in={v for vs in by_issue.values() for v in vs})
                records = list(queryset.select_related(*joins) if joins else queryset)
                expanded = dict(zip((record.pk for record in records), serializer(records, many=True).data))
                for issue_id, values in by_issue.items():
                    wanted = set(values)
                    by_issue[issue_id] = [row for pk, row in expanded.items() if pk in wanted]
            else:
                by_issue = {issue_id: [str(value) for value in values] for issue_id, values in by_issue.items()}
            self.related_by_issue[field] = by_issue

    def to_representation(self, instance):
        # Not super(): IssueSerializer.to_representation is what runs the per-row queries.
        data = BaseSerializer.to_representation(self, instance)
        for field, by_issue in self.related_by_issue.items():
            data[field] = by_issue.get(instance.id, [])
        return data


def related_work_items(issues, relation_type_of) -> list[dict]:
    """plane-sdk WorkItemWithRelationType rows for `issues`.

    `relation_type_of(issue)` gives the label from the viewed work item's side.
    """
    issues = list(issues)
    ids = [issue.id for issue in issues]
    labels: dict = {}
    for issue_id, label_id in IssueLabel.objects.filter(issue_id__in=ids).values_list("issue_id", "label_id"):
        labels.setdefault(issue_id, []).append(str(label_id))
    assignees: dict = {}
    for issue_id, user_id in IssueAssignee.objects.filter(issue_id__in=ids).values_list("issue_id", "assignee_id"):
        assignees.setdefault(issue_id, []).append(str(user_id))

    def as_str(value):
        return str(value) if value is not None else None

    return [
        {
            "id": str(issue.id),
            "name": issue.name,
            "sequence_id": issue.sequence_id,
            "project_id": str(issue.project_id),
            "project_identifier": issue.project.identifier,
            "state_id": as_str(issue.state_id),
            "priority": issue.priority,
            "type_id": as_str(issue.type_id),
            "is_epic": bool(issue.type and issue.type.is_epic),
            "label_ids": labels.get(issue.id, []),
            "assignee_ids": assignees.get(issue.id, []),
            "sort_order": issue.sort_order,
            "created_at": issue.created_at.isoformat() if issue.created_at else None,
            "updated_at": issue.updated_at.isoformat() if issue.updated_at else None,
            "created_by": as_str(issue.created_by_id),
            "updated_by": as_str(issue.updated_by_id),
            "relation_type": relation_type_of(issue),
        }
        for issue in issues
    ]
