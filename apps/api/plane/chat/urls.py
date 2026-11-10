# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Every Nexus Messages route, mounted at /api/workspaces/<str:slug>/chat/ (see plane/urls.py).

The mount captures the workspace slug, so each view here receives it as the `slug` kwarg.
"""

from django.urls import path

from plane.chat.views import (
    AgentDmDetailEndpoint,
    AgentDmEndpoint,
    AgentDmPermissionDetailEndpoint,
    AgentDmPermissionEndpoint,
    AgentDmStopEndpoint,
    AttachmentDetailEndpoint,
    AttachmentEndpoint,
    ChannelAgentDetailEndpoint,
    ChannelAgentEndpoint,
    ChannelArchiveEndpoint,
    ChannelDetailEndpoint,
    ChannelEndpoint,
    ChannelJoinEndpoint,
    ChannelLeaveEndpoint,
    ChannelMemberDetailEndpoint,
    ChannelMemberEndpoint,
    ChannelReadEndpoint,
    ChatMeEndpoint,
    DirectMessageEndpoint,
    GuestDmAccessEndpoint,
    GuestDmAccessListEndpoint,
    MessageDetailEndpoint,
    MessageEndpoint,
    MessageReplyEndpoint,
    MessageSearchEndpoint,
    MessageWorkItemEndpoint,
)

CHANNEL = "channels/<uuid:channel_id>/"

urlpatterns = [
    path("me/", ChatMeEndpoint.as_view(), name="chat-me"),
    path("channels/", ChannelEndpoint.as_view(), name="chat-channels"),
    path("dms/", DirectMessageEndpoint.as_view(), name="chat-dms"),
    path("agent-dms/", AgentDmEndpoint.as_view(), name="chat-agent-dms"),
    path("search/", MessageSearchEndpoint.as_view(), name="chat-search"),
    path("guests/dm-access/", GuestDmAccessListEndpoint.as_view(), name="chat-guest-dm-access-list"),
    path("guests/<uuid:user_id>/dm-access/", GuestDmAccessEndpoint.as_view(), name="chat-guest-dm-access"),
    path(CHANNEL, ChannelDetailEndpoint.as_view(), name="chat-channel"),
    path(f"{CHANNEL}archive/", ChannelArchiveEndpoint.as_view(), name="chat-channel-archive"),
    path(f"{CHANNEL}join/", ChannelJoinEndpoint.as_view(), name="chat-channel-join"),
    path(f"{CHANNEL}leave/", ChannelLeaveEndpoint.as_view(), name="chat-channel-leave"),
    path(f"{CHANNEL}read/", ChannelReadEndpoint.as_view(), name="chat-channel-read"),
    path(f"{CHANNEL}members/", ChannelMemberEndpoint.as_view(), name="chat-channel-members"),
    path(f"{CHANNEL}members/<uuid:user_id>/", ChannelMemberDetailEndpoint.as_view(), name="chat-channel-member"),
    path(f"{CHANNEL}agents/", ChannelAgentEndpoint.as_view(), name="chat-channel-agents"),
    path(f"{CHANNEL}agents/<uuid:agent_id>/", ChannelAgentDetailEndpoint.as_view(), name="chat-channel-agent"),
    path(f"{CHANNEL}agent-dm/", AgentDmDetailEndpoint.as_view(), name="chat-agent-dm"),
    path(f"{CHANNEL}agent-dm/stop/", AgentDmStopEndpoint.as_view(), name="chat-agent-dm-stop"),
    path(f"{CHANNEL}agent-dm/permissions/", AgentDmPermissionEndpoint.as_view(), name="chat-agent-dm-permissions"),
    path(
        f"{CHANNEL}agent-dm/permissions/<str:request_id>/",
        AgentDmPermissionDetailEndpoint.as_view(),
        name="chat-agent-dm-permission",
    ),
    path(f"{CHANNEL}attachments/", AttachmentEndpoint.as_view(), name="chat-attachments"),
    path(f"{CHANNEL}attachments/<uuid:asset_id>/", AttachmentDetailEndpoint.as_view(), name="chat-attachment"),
    path(f"{CHANNEL}messages/", MessageEndpoint.as_view(), name="chat-messages"),
    path(f"{CHANNEL}messages/<uuid:message_id>/", MessageDetailEndpoint.as_view(), name="chat-message"),
    path(f"{CHANNEL}messages/<uuid:message_id>/replies/", MessageReplyEndpoint.as_view(), name="chat-message-replies"),
    path(
        f"{CHANNEL}messages/<uuid:message_id>/work-items/",
        MessageWorkItemEndpoint.as_view(),
        name="chat-message-work-items",
    ),
]
