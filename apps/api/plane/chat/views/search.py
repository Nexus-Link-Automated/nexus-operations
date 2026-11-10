# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Searching the messages the caller may read (see `plane.chat.search`)."""

from rest_framework.response import Response

from plane.chat.agents import agents_by_slug
from plane.chat.attachments import attachments_for
from plane.chat.pagination import paginate_newest_first
from plane.chat.permissions import visible_channels
from plane.chat.references import references_for
from plane.chat.search import readable_messages, search_messages, snippet_segments, to_tsquery_text, with_snippet
from plane.chat.serializers import MessageSearchQuerySerializer, MessageSerializer, SearchChannelSerializer
from plane.chat.views.base import ChatBaseEndpoint, annotate_messages

DEFAULT_LIMIT = 20
MAX_LIMIT = 50


class MessageSearchEndpoint(ChatBaseEndpoint):
    rate_limits = {"GET": "search"}

    def get(self, request, slug):
        """Messages and replies matching `q`, newest first, from the channels and DMs the caller may read.

        Filters: `channel` (404 if the caller can't see it), `sender` (a user), `since` and `until` (ISO 8601), and
        `automatic=false`. Paged like the message list: `before` (the last result's ID) and `limit`.
        """
        params = MessageSearchQuerySerializer(data=request.query_params.dict())
        params.is_valid(raise_exception=True)
        data = params.validated_data
        query_text = to_tsquery_text(data["q"])
        if not query_text:
            # Only punctuation, say: nothing to look for, so nothing matches.
            return Response({"results": [], "has_more": False})

        user = request.user
        matches = search_messages(user, slug, self.role, query_text)
        if "channel" in data:
            matches = matches.filter(channel=self.get_channel(data["channel"]))
        if "sender" in data:
            matches = matches.filter(sender_id=data["sender"])
        if "since" in data:
            matches = matches.filter(created_at__gte=data["since"])
        if "until" in data:
            matches = matches.filter(created_at__lt=data["until"])
        if not data["automatic"]:
            matches = matches.filter(system_event__isnull=True)

        messages, has_more = paginate_newest_first(
            with_snippet(annotate_messages(matches), query_text),
            request.query_params,
            readable_messages(user, slug, self.role),
            DEFAULT_LIMIT,
            MAX_LIMIT,
        )
        channels = {
            channel.id: channel
            for channel in visible_channels(user, slug, self.role).filter(pk__in={m.channel_id for m in messages})
        }
        context = {
            "references": references_for([message.id for message in messages], user),
            "attachments": attachments_for(messages, user),
            "agents": agents_by_slug(message.sender_agent for message in messages),
        }
        return Response(
            {
                "results": [
                    {
                        "message": MessageSerializer(message, context=context).data,
                        "channel": SearchChannelSerializer(channels[message.channel_id]).data,
                        "snippet": snippet_segments(message.snippet, message.body_stripped),
                    }
                    for message in messages
                    # Lost access since the search ran.
                    if message.channel_id in channels
                ],
                "has_more": has_more,
            }
        )
