# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import base64
import binascii

from rest_framework import serializers

from plane.coding.models import EVENT_TEXT_MAX, CodingAgent, CodingMachine, EventKind
from plane.coding.serializers.base import StrictSerializer

NAME = {"max_length": 80, "trim_whitespace": True, "allow_blank": False}


class CodingMachineSerializer(serializers.ModelSerializer):
    owner_display_name = serializers.CharField(source="owner.display_name", read_only=True)
    # A bot member's machine: workspace admins manage it.
    owner_is_bot = serializers.BooleanField(source="owner.is_bot", read_only=True)
    is_online = serializers.BooleanField(read_only=True)
    join_code_expired = serializers.BooleanField(read_only=True)

    class Meta:
        model = CodingMachine
        fields = [
            "id",
            "workspace",
            "owner",
            "owner_display_name",
            "owner_is_bot",
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


class AddMachineSerializer(MachineNameSerializer):
    # A bot member's id: a workspace admin adds the machine for that bot.
    owner = serializers.UUIDField(required=False, allow_null=True)


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
    # The jobs the machine is running now. Left out (a machine from before dispatch), it gets no jobs.
    running = serializers.ListField(child=serializers.UUIDField(), max_length=32, required=False)


# Progress and results from the machine.

MAX_EVENT_JOBS = 32
MAX_EVENTS_PER_BATCH = 50


class _Event(StrictSerializer):
    kind = serializers.ChoiceField(choices=EventKind.choices)
    # Cut rather than refused: a long line from the agent should not lose the whole batch.
    text = serializers.CharField(max_length=EVENT_TEXT_MAX * 4, trim_whitespace=False)

    def validate_text(self, value):
        return value[:EVENT_TEXT_MAX]


class _JobEvents(StrictSerializer):
    id = serializers.UUIDField()
    events = _Event(many=True, max_length=MAX_EVENTS_PER_BATCH)


class JobEventsSerializer(StrictSerializer):
    jobs = _JobEvents(many=True, max_length=MAX_EVENT_JOBS)


# The files a job changed, sent with its result for the CRM to push (`plane.coding.publish`).
MAX_CHANGED_FILES = 200
MAX_CHANGES_BYTES = 3 * 1024 * 1024
FILE_MODES = ("100644", "100755", "120000")


def _check_path(path: str) -> str:
    """A path inside the repository: relative, no `.`/`..` parts, nothing under `.git`."""
    if not path or "\0" in path or "\\" in path or path.startswith("/") or path.endswith("/"):
        raise serializers.ValidationError("Not a path inside the repository.")
    parts = path.split("/")
    if any(part in ("", ".", "..") or part.lower() == ".git" for part in parts):
        raise serializers.ValidationError("Not a path inside the repository.")
    return path


class _ChangedFile(StrictSerializer):
    path = serializers.CharField(max_length=500, trim_whitespace=False)
    mode = serializers.ChoiceField(choices=FILE_MODES, required=False)
    # Base64 of the file's new content (a symbolic link's: its target).
    content = serializers.CharField(
        max_length=MAX_CHANGES_BYTES * 4 // 3 + 4, allow_blank=True, trim_whitespace=False, required=False
    )
    deleted = serializers.BooleanField(required=False)

    def validate_path(self, value):
        return _check_path(value)

    def validate(self, attrs):
        if attrs.get("deleted"):
            if "content" in attrs or "mode" in attrs:
                raise serializers.ValidationError("A deleted file has no mode or content.")
            return {"path": attrs["path"], "deleted": True}
        if "content" not in attrs or "mode" not in attrs:
            raise serializers.ValidationError("A changed file needs its mode and content.")
        try:
            size = len(base64.b64decode(attrs["content"], validate=True))
        except (binascii.Error, ValueError):
            raise serializers.ValidationError({"content": ["Not base64."]})
        return {"path": attrs["path"], "mode": attrs["mode"], "content": attrs["content"], "size": size}


class _Changes(StrictSerializer):
    base_commit = serializers.RegexField(r"^[0-9a-f]{40}$")
    files = _ChangedFile(many=True, min_length=1, max_length=MAX_CHANGED_FILES)

    def validate(self, attrs):
        paths = [file["path"] for file in attrs["files"]]
        if len(set(paths)) != len(paths):
            raise serializers.ValidationError({"files": ["A path is listed twice."]})
        total = sum(file.pop("size", 0) for file in attrs["files"])
        if total > MAX_CHANGES_BYTES:
            raise serializers.ValidationError({"files": [f"The changes are larger than {MAX_CHANGES_BYTES} bytes."]})
        return attrs


class JobResultSerializer(StrictSerializer):
    # Validated against the job's action by `plane.coding.outcomes.validate_result`.
    result = serializers.DictField()
    # The files the job changed, when its outcome is one with code (`fixed`, `test_written`, ...).
    changes = _Changes(required=False)
    # Why a job with changed files sends none (too large, ...); said in the comment.
    changes_note = serializers.CharField(max_length=300, required=False)
