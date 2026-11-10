# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import json
import re

from rest_framework import serializers

from plane.app.serializers.base import BaseSerializer
from plane.chat.attachments import MAX_ATTACHMENTS_PER_MESSAGE
from plane.chat.models import Message, MessageSystemEvent
from plane.chat.project_feed import body_for_reader
from plane.utils.content_validator import validate_html_content

# Slack's limit. Plane's 10 MB limit for descriptions is far beyond what a chat message needs.
MAX_BODY_HTML_LENGTH = 40_000
MAX_BODY_JSON_BYTES = 200_000

# Markup that renders as nothing: empty paragraphs, line breaks, non-breaking spaces, whitespace.
# Attributes count too: packages/editor's empty paragraph is `<p class="editor-paragraph-block"></p>`.
_BLANK_MARKUP = re.compile(r"</?p\b[^>]*>|<br\b[^>]*>|&nbsp;|\s", re.IGNORECASE)

# JSON can carry these in a string, but Postgres's jsonb refuses them.
_NOT_STORABLE_IN_JSONB = re.compile("[\x00\ud800-\udfff]")


def _storable_in_jsonb(value):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, str) and _NOT_STORABLE_IN_JSONB.search(item):
            return False
    return True


class MessageSerializer(BaseSerializer):
    """A message, or a removed message's tombstone (empty body, `removed_at` set).

    Read the instance through `views.base.annotate_messages`.
    """

    reply_count = serializers.IntegerField(read_only=True)
    last_reply_at = serializers.DateTimeField(read_only=True, allow_null=True)
    references = serializers.SerializerMethodField()
    attachments = serializers.SerializerMethodField()
    attachment_count = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = [
            "id",
            "workspace",
            "channel",
            "sender",
            "sender_agent",
            "system_event",
            "body_html",
            "body_json",
            "body_stripped",
            "parent",
            "reply_count",
            "last_reply_at",
            "references",
            "attachments",
            "attachment_count",
            "edited_at",
            "removed_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def to_representation(self, message):
        data = super().to_representation(message)
        if message.system_event == MessageSystemEvent.WORK_ITEM_STATE and message.removed_at is None:
            visible_keys = {reference["id"]: reference["key"] for reference in data["references"]}
            data["body_html"] = body_for_reader(message, visible_keys)
        return data

    def get_references(self, message):
        """The work items this message references, as far as the reader may see them (`references_for`)."""
        return self.context.get("references", {}).get(message.id, [])

    def get_attachments(self, message):
        """Its files, for a channel member only (`attachments_for`)."""
        return self.context.get("attachments", {}).get(message.id, {}).get("files", [])

    def get_attachment_count(self, message):
        """How many files it has, which a reader who isn't in the channel sees instead of the files."""
        return self.context.get("attachments", {}).get(message.id, {}).get("count", 0)


class MessageWriteSerializer(serializers.Serializer):
    """A new or edited message. `parent_id` (a top-level message in the channel) makes it a reply.

    `attachment_ids` are finished uploads; a message that has some doesn't need any text.
    """

    body_html = serializers.CharField(
        max_length=MAX_BODY_HTML_LENGTH, trim_whitespace=False, required=False, allow_blank=True, default=""
    )
    body_json = serializers.JSONField(required=False, default=dict)
    parent_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    attachment_ids = serializers.ListField(
        child=serializers.UUIDField(), required=False, default=list, max_length=MAX_ATTACHMENTS_PER_MESSAGE
    )

    def validate_body_html(self, value):
        is_valid, error, clean_html = validate_html_content(value)
        if not is_valid:
            raise serializers.ValidationError(error or "HTML content is not valid")
        return clean_html if clean_html is not None else value

    def validate_body_json(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("body_json must be an object.")
        if len(json.dumps(value)) > MAX_BODY_JSON_BYTES:
            raise serializers.ValidationError("body_json is too large.")
        if not _storable_in_jsonb(value):
            raise serializers.ValidationError("body_json contains characters that can't be stored.")
        return value

    def validate(self, data):
        if not _BLANK_MARKUP.sub("", data["body_html"]) and not self._has_attachments(data):
            raise serializers.ValidationError({"body_html": ["A message can't be empty."]})
        return data

    def _has_attachments(self, data):
        return bool(data["attachment_ids"])


class MessageWorkItemSerializer(serializers.Serializer):
    """A work item just created from a message, to link to it."""

    issue_id = serializers.UUIDField()


class MessageEditSerializer(MessageWriteSerializer):
    """Editing changes the body only: a message never moves between threads, and keeps the files it was sent with.

    Pass `has_attachments` in the context for a message that has some, which can then be emptied of text.
    """

    body_html = serializers.CharField(max_length=MAX_BODY_HTML_LENGTH, trim_whitespace=False, allow_blank=True)
    parent_id = None
    attachment_ids = None

    def _has_attachments(self, data):
        return self.context.get("has_attachments", False)
