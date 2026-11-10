# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Messages: read a channel's history or a thread, send, edit and remove.

Everyone who can see a channel can read it; sending, editing and removing your own
messages need channel membership. Messages
are always sent as the caller. Removing a message calls `Message.remove()`, which
leaves a tombstone so replies and read cursors keep working; it is never deleted.
Automatic messages (`system_event`, see `project_feed`) have no sender, so only an
admin can remove one and nobody can edit it.
"""

from html import escape

from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.chat.agents import agents_by_slug
from plane.chat.attachments import attachments_for, claim_attachments, has_attachments
from plane.chat.events import EventType, message_event, publish_on_commit
from plane.chat.exceptions import BadRequest, Conflict, Forbidden, NotFound
from plane.chat.models import ChannelKind, Message, MessageReference
from plane.chat.notifications import message_url, notify_mentions, refresh_mention_previews
from plane.chat.pagination import paginate_messages
from plane.chat.references import references_for, sync_references, visible_work_item
from plane.chat.permissions import is_channel_admin, require_channel_member, require_not_archived
from plane.chat.serializers import (
    MessageEditSerializer,
    MessageSerializer,
    MessageWorkItemSerializer,
    MessageWriteSerializer,
)
from plane.chat.views.base import ChatBaseEndpoint, annotate_messages
from plane.db.models import IssueLink
from plane.utils.host import base_host


def _serialized(messages, user, many):
    ids = [message.id for message in messages]
    context = {
        "references": references_for(ids, user),
        "attachments": attachments_for(messages, user),
        "agents": agents_by_slug(message.sender_agent for message in messages),
    }
    return MessageSerializer(messages if many else messages[0], many=many, context=context).data


def _page(queryset, request):
    messages, has_more = paginate_messages(annotate_messages(queryset), request.query_params)
    return Response({"results": _serialized(messages, request.user, many=True), "has_more": has_more})


def _payload(message_id, user):
    return _serialized([annotate_messages(Message.objects.filter(pk=message_id)).get()], user, many=False)


class MessageEndpoint(ChatBaseEndpoint):
    rate_limits = {"POST": "send"}

    def get(self, request, slug, channel_id):
        """A page of top-level messages. Query: `before` or `after` (a message ID) and `limit`."""
        channel = self.get_channel(channel_id)
        return _page(Message.objects.filter(channel=channel, parent__isnull=True), request)

    def post(self, request, slug, channel_id):
        """Send a message as the caller, or a thread reply with `parent_id`."""
        channel = self.get_channel(channel_id)
        require_channel_member(channel)
        require_not_archived(channel)
        serializer = MessageWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        parent = None
        if data["parent_id"] is not None:
            parent = Message.objects.filter(channel=channel, pk=data["parent_id"]).first()
            if parent is None:
                raise BadRequest("parent_id is not a message in this channel.")
            if parent.parent_id is not None:
                raise BadRequest("Reply to the thread's first message; threads are one level deep.")

        # One transaction, so a refused attachment leaves no message behind.
        with transaction.atomic():
            message = Message.objects.create(
                channel=channel,
                sender=request.user,
                parent=parent,
                body_html=data["body_html"],
                body_json=data["body_json"],
            )
            claim_attachments(message, data["attachment_ids"], request.user)
        # Before the event: whoever it reaches fetches the message, and should get its references.
        sync_references(message)
        publish_on_commit(message_event(EventType.MESSAGE_CREATED, message))
        notify_mentions(message)
        return Response(_payload(message.id, request.user), status=status.HTTP_201_CREATED)


class MessageDetailEndpoint(ChatBaseEndpoint):
    rate_limits = {"PATCH": "edit", "DELETE": "edit"}

    def _message(self, channel, message_id, lock=False):
        messages = Message.objects.select_for_update() if lock else Message.objects
        message = messages.filter(channel=channel, pk=message_id).first()
        if message is None:
            raise NotFound("Message not found.")
        return message

    def get(self, request, slug, channel_id, message_id):
        channel = self.get_channel(channel_id)
        return Response(_payload(self._message(channel, message_id).id, request.user))

    def patch(self, request, slug, channel_id, message_id):
        """Edit your own message in a channel you're in. Removed messages and archived channels can't be edited."""
        channel = self.get_channel(channel_id)
        # Locked until the write, so a removal that lands meanwhile can't have its body written back.
        with transaction.atomic():
            message = self._message(channel, message_id, lock=True)
            require_channel_member(channel)
            if message.sender_id != request.user.id:
                raise Forbidden("Only the sender can edit a message.")
            if message.removed_at is not None:
                raise Conflict("The message was removed.")
            require_not_archived(channel)
            serializer = MessageEditSerializer(data=request.data, context={"has_attachments": has_attachments(message)})
            serializer.is_valid(raise_exception=True)
            data = serializer.validated_data

            previous_html = message.body_html
            message.body_html = data["body_html"]
            message.body_json = data["body_json"]
            message.edited_at = timezone.now()
            message.save(
                update_fields=["body_html", "body_json", "body_stripped", "edited_at", "updated_at", "updated_by"]
            )
            sync_references(message)
            publish_on_commit(message_event(EventType.MESSAGE_UPDATED, message))
            notify_mentions(message, previous_html)
            refresh_mention_previews(message)
        return Response(_payload(message.id, request.user))

    def delete(self, request, slug, channel_id, message_id):
        """Remove a message: its sender while in the channel, a channel admin, or a workspace admin.

        In a DM or group DM, only its sender. Removing twice is a no-op.
        """
        channel = self.get_channel(channel_id)
        # Locked so that when two removals overlap, the second sees the first and only one is announced.
        with transaction.atomic():
            message = self._message(channel, message_id, lock=True)
            if not is_channel_admin(channel, self.role):
                require_channel_member(channel)
                if message.sender_id != request.user.id:
                    raise Forbidden(
                        "Only the sender can remove a direct message."
                        if channel.is_direct
                        else "Only the sender or an admin can remove a message."
                    )
            require_not_archived(channel)
            if message.removed_at is None:
                message.remove()
                refresh_mention_previews(message)
                publish_on_commit(message_event(EventType.MESSAGE_REMOVED, message))
        return Response(status=status.HTTP_204_NO_CONTENT)


class MessageReplyEndpoint(ChatBaseEndpoint):
    def get(self, request, slug, channel_id, message_id):
        """A page of a thread's replies, with the same cursors as the channel's messages."""
        channel = self.get_channel(channel_id)
        parent = Message.objects.filter(channel=channel, pk=message_id, parent__isnull=True).first()
        if parent is None:
            raise NotFound("Message not found.")
        return _page(Message.objects.filter(parent=parent), request)


class MessageWorkItemEndpoint(ChatBaseEndpoint):
    rate_limits = {"POST": "work_item"}

    def post(self, request, slug, channel_id, message_id):
        """Link a work item created from this message, both ways, and say so in its thread.

        The work item is created first through Plane's own form, so its permissions and activity stay Plane's. Linking
        the same one again changes nothing and posts nothing.
        """
        channel = self.get_channel(channel_id)
        message = Message.objects.filter(channel=channel, pk=message_id, removed_at__isnull=True).first()
        if message is None:
            raise NotFound("Message not found.")
        require_channel_member(channel)
        require_not_archived(channel)
        if message.system_event is not None:
            raise BadRequest("An automatic message can't be turned into a work item.")
        serializer = MessageWorkItemSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        issue = visible_work_item(serializer.validated_data["issue_id"], request.user, message.workspace_id)
        if issue is None:
            raise NotFound("Work item not found.")

        key = f"{issue.project.identifier}-{issue.sequence_id}"
        # The thread the message is in: its own, or for a reply its parent's. The link opens a reply in it.
        thread = message.parent or message
        permalink = message_url(base_host(request=request, is_app=True), slug, message)
        # A private conversation's name doesn't belong on a work item that other people can read.
        link_title = (
            f"Message in #{channel.name}" if channel.kind == ChannelKind.PUBLIC else "Message in Nexus Messages"
        )

        with transaction.atomic():
            _, created = MessageReference.objects.get_or_create(
                message=message,
                issue=issue,
                defaults={"workspace_id": message.workspace_id, "created_from_message": True},
            )
            IssueLink.objects.get_or_create(
                issue=issue, url=permalink, defaults={"title": link_title, "project": issue.project}
            )
            reply = None
            if created:
                # In the thread: the card on the message already tells the channel.
                reply = Message.objects.create(
                    channel=channel,
                    sender=request.user,
                    parent=thread,
                    body_html=f'<p>Created {escape(key)} from <a href="{escape(permalink)}">this message</a></p>',
                )
                MessageReference.objects.create(message=reply, issue=issue)
                publish_on_commit(
                    message_event(EventType.MESSAGE_UPDATED, message),
                    message_event(EventType.MESSAGE_CREATED, reply),
                )

        return Response(
            {
                "message": _payload(message.id, request.user),
                "reply": _payload(reply.id, request.user) if reply else None,
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
