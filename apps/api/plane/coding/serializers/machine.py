# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.coding.models import CodingAgent, CodingMachine
from plane.coding.serializers.base import StrictSerializer

NAME = {"max_length": 80, "trim_whitespace": True, "allow_blank": False}


class CodingMachineSerializer(serializers.ModelSerializer):
    owner_display_name = serializers.CharField(source="owner.display_name", read_only=True)
    is_online = serializers.BooleanField(read_only=True)
    join_code_expired = serializers.BooleanField(read_only=True)

    class Meta:
        model = CodingMachine
        fields = [
            "id",
            "workspace",
            "owner",
            "owner_display_name",
            "name",
            "state",
            "is_online",
            "last_seen_at",
            "hostname",
            "os",
            "version",
            "capabilities",
            "join_code_expires_at",
            "join_code_expired",
            "joined_at",
            "approved_at",
            "revoked_at",
            "revoked_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class MachineNameSerializer(StrictSerializer):
    name = serializers.CharField(**NAME)


# What a machine reports about itself. Bounded, so a machine cannot store anything large; only shown, never trusted.


class _AgentReport(StrictSerializer):
    id = serializers.ChoiceField(choices=CodingAgent.choices)
    installed = serializers.BooleanField()
    signed_in = serializers.BooleanField()
    version = serializers.CharField(max_length=64, allow_blank=True, required=False, allow_null=True)


class _ToolchainReport(StrictSerializer):
    name = serializers.CharField(max_length=32)
    version = serializers.CharField(max_length=64, allow_blank=True)


class _DockerReport(StrictSerializer):
    available = serializers.BooleanField()
    version = serializers.CharField(max_length=64, allow_blank=True, required=False, allow_null=True)


class _SlotsReport(StrictSerializer):
    total = serializers.IntegerField(min_value=0, max_value=32)
    free = serializers.IntegerField(min_value=0, max_value=32)

    def validate(self, attrs):
        if attrs["free"] > attrs["total"]:
            raise serializers.ValidationError({"free": ["Cannot be more than total."]})
        return attrs


class _CapabilitiesReport(StrictSerializer):
    agents = _AgentReport(many=True, max_length=len(CodingAgent.choices))
    toolchains = _ToolchainReport(many=True, max_length=30)
    docker = _DockerReport()
    slots = _SlotsReport()


class _About(StrictSerializer):
    hostname = serializers.CharField(max_length=255, allow_blank=True, required=False)
    os = serializers.CharField(max_length=64, allow_blank=True, required=False)
    version = serializers.CharField(max_length=32, allow_blank=True, required=False)


class JoinSerializer(_About):
    code = serializers.CharField(max_length=64)


class HeartbeatSerializer(_About):
    capabilities = _CapabilitiesReport(required=False)
