# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Messages, their thread replies, and the work items they reference.

A message is sent by a user (`sender`), by an agent (`sender_agent`, the agent's
slug), or by Nexus itself (`system_event`, what it announces), and only ever one of
them. A user deleting a message calls `remove()`: the body and attachments are
cleared and `removed_at` is set, but the row stays so its thread replies and read
cursors keep working. `deleted_at` (soft delete) is reserved for removing data for real.
"""

from django.core.exceptions import ValidationError
from django.db import models, transaction
from django.db.models import F, Q
from django.utils import timezone
from django.utils.html import strip_tags

from plane.db.models import BaseModel, FileAsset

__all__ = ["Message", "MessageReference", "MessageSystemEvent"]

_ALIVE = Q(deleted_at__isnull=True)


class MessageSystemEvent(models.TextChoices):
    """What an automatic message announces. Nobody typed it, so nobody can edit it."""

    WORK_ITEM_STATE = "work_item_state", "Work item state changes"


class Message(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="chat_messages")
    channel = models.ForeignKey("chat.Channel", on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey("db.User", on_delete=models.CASCADE, null=True, blank=True, related_name="chat_messages")
    # Slug of an instance-level agent (`AgentDefinition.slug` on the agent branches).
    sender_agent = models.SlugField(max_length=100, null=True, blank=True)
    system_event = models.CharField(max_length=32, choices=MessageSystemEvent.choices, null=True, blank=True)
    # What an automatic message is about, for rendering it per reader (`project_feed.body_for_reader`).
    system_data = models.JSONField(null=True, blank=True)
    body_html = models.TextField(blank=True, default="<p></p>")
    # Stored as the client sent it, unlike the sanitized body_html: render from body_html, never from this.
    body_json = models.JSONField(blank=True, default=dict)
    body_stripped = models.TextField(blank=True, default="")
    # Threads are one level deep: a reply's parent is always a top-level message.
    parent = models.ForeignKey("self", on_delete=models.CASCADE, null=True, blank=True, related_name="replies")
    edited_at = models.DateTimeField(null=True, blank=True)
    removed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "chat_messages"
        ordering = ("created_at",)
        constraints = [
            models.CheckConstraint(
                condition=(Q(sender__isnull=False) & Q(sender_agent__isnull=True) & Q(system_event__isnull=True))
                | (
                    Q(sender__isnull=True)
                    & Q(sender_agent__isnull=False)
                    & ~Q(sender_agent="")
                    & Q(system_event__isnull=True)
                )
                | (
                    Q(sender__isnull=True)
                    & Q(sender_agent__isnull=True)
                    & Q(system_event__isnull=False)
                    & ~Q(system_event="")
                ),
                name="chat_message_one_sender",
            ),
            models.CheckConstraint(condition=~Q(parent=F("id")), name="chat_message_not_own_parent"),
        ]
        indexes = [
            models.Index(fields=["channel", "created_at"], name="chat_message_channel_idx"),
            models.Index(fields=["parent", "created_at"], name="chat_message_parent_idx"),
        ]

    def save(self, *args, **kwargs):
        self.workspace_id = self.channel.workspace_id
        if self.parent_id is not None:
            if self.parent.channel_id != self.channel_id:
                raise ValidationError("A reply must be in the same channel as its parent.")
            if self.parent.parent_id is not None:
                raise ValidationError("A reply cannot have replies of its own.")
        self.body_stripped = strip_tags(self.body_html) if self.body_html else ""
        super().save(*args, **kwargs)

    def remove(self):
        """Delete the message as the user sees it: clear the body and drop its references and attachments."""
        with transaction.atomic():
            self.body_html = ""
            self.body_json = {}
            self.system_data = None
            self.removed_at = timezone.now()
            self.save(
                update_fields=[
                    "body_html",
                    "body_json",
                    "body_stripped",
                    "system_data",
                    "removed_at",
                    "updated_at",
                    "updated_by",
                ]
            )
            self.references.all().delete()
            # Filtered by entity type: entity_identifier means something else on other entity types.
            FileAsset.objects.filter(
                entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT, entity_identifier=str(self.pk)
            ).update(is_deleted=True, deleted_at=self.removed_at)


class MessageReference(BaseModel):
    """A work item mentioned in a message."""

    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="chat_message_references")
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name="references")
    issue = models.ForeignKey("db.Issue", on_delete=models.CASCADE, related_name="chat_message_references")
    # The work item was created from this message, so it stays linked whatever the message's text says.
    created_from_message = models.BooleanField(default=False)

    class Meta:
        db_table = "chat_message_references"
        ordering = ("created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["message", "issue"], condition=_ALIVE, name="chat_message_reference_unique"
            ),
        ]

    def save(self, *args, **kwargs):
        self.workspace_id = self.message.workspace_id
        if self.issue.workspace_id != self.workspace_id:
            raise ValidationError("A message can only reference work items in its own workspace.")
        super().save(*args, **kwargs)
