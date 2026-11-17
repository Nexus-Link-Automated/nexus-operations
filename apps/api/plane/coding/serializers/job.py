# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.coding.models import CodingAction, CodingAgent, CodingJob, CodingJobEvent
from plane.coding.serializers.base import StrictSerializer


class CodingJobSerializer(serializers.ModelSerializer):
    work_item = serializers.UUIDField(source="issue_id", read_only=True)
    is_active = serializers.BooleanField(read_only=True)
    is_retryable = serializers.BooleanField(read_only=True)

    class Meta:
        model = CodingJob
        fields = [
            "id",
            "workspace",
            "project",
            "work_item",
            "action",
            "agent",
            "status",
            "outcome",
            "result",
            "pr_url",
            "pr_branch",
            "error_reason",
            "retry_of",
            "machine",
            "ran_on",
            "ran_on_name",
            "progress",
            "progress_at",
            "deadline_at",
            "result_received_at",
            "comment",
            "requested_by",
            "is_active",
            "is_retryable",
            "started_at",
            "finished_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class CodingJobEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = CodingJobEvent
        fields = ["seq", "kind", "text", "created_at"]
        read_only_fields = fields


class StartJobSerializer(StrictSerializer):
    action = serializers.ChoiceField(choices=CodingAction.choices)
    agent = serializers.ChoiceField(choices=CodingAgent.choices)
    # One of the requester's approved machines; null or left out means Auto.
    machine = serializers.UUIDField(required=False, allow_null=True)


class RetryJobSerializer(StrictSerializer):
    # The agent to use this time; the retried job's agent when left out.
    agent = serializers.ChoiceField(choices=CodingAgent.choices, required=False)
    # null means Auto. Left out: the retried job's machine if it is still one of the retrier's approved machines,
    # else Auto.
    machine = serializers.UUIDField(required=False, allow_null=True)
