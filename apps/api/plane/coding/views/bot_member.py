# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Bot members (EmployAI agents): workspace admins create, change, re-key and remove them
(`plane.coding.bot_members`)."""

from rest_framework import status
from rest_framework.response import Response

from plane.coding import bot_members
from plane.coding.exceptions import Forbidden
from plane.coding.models import BotMember
from plane.coding.serializers.bot_member import BotCreateSerializer, BotUpdateSerializer, bot_payload

from .machine import _WorkspaceMachines


class _BotMembers(_WorkspaceMachines):
    def require_bot_admin(self):
        """A person who is a workspace admin. Never a bot, and never an in-app agent's session: a bot's token is a
        credential, and an agent works from text anyone in the workspace can write."""
        if self.request.user.is_bot:
            raise Forbidden("Bots cannot manage bot members.", code="BOT_NOT_ALLOWED")
        self.require_admin()
        token = getattr(self.request, "auth", None)
        from plane.db.models.api import AGENT_SESSION_TOKEN_LABEL, APIToken

        if isinstance(token, str) and APIToken.objects.filter(token=token, label=AGENT_SESSION_TOKEN_LABEL).exists():
            raise Forbidden("An agent session cannot manage bot members.", code="AGENT_SESSION_NOT_ALLOWED")

    def get_bot(self):
        return bot_members.get_bot(self.workspace, self.kwargs["bot_id"])


class BotMemberListMixin(_BotMembers):
    def get(self, request, slug):
        """The workspace's bot members, removed ones included (`is_active`)."""
        self.require_bot_admin()
        bots = BotMember.objects.filter(workspace=self.workspace).select_related("user")
        return Response([bot_payload(bot) for bot in bots])

    def post(self, request, slug):
        """Create a bot member. The answer carries its access `token`: shown once, never again."""
        self.require_bot_admin()
        serializer = BotCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        bot, token = bot_members.create_bot(self.workspace, data["name"], data["role"], data["description"])
        return Response(bot_payload(bot, token=token), status=status.HTTP_201_CREATED)


class BotMemberDetailMixin(_BotMembers):
    def get(self, request, slug, bot_id):
        self.require_bot_admin()
        return Response(bot_payload(self.get_bot()))

    def patch(self, request, slug, bot_id):
        """Change the name, role (member or guest) or description."""
        self.require_bot_admin()
        serializer = BotUpdateSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        bot = bot_members.update_bot(self.get_bot(), **serializer.validated_data)
        return Response(bot_payload(bot))

    def delete(self, request, slug, bot_id):
        """Remove it from the workspace and its projects, as removing any member does; its tokens stop working."""
        self.require_bot_admin()
        bot_members.remove_bot(self.get_bot())
        return Response(status=status.HTTP_204_NO_CONTENT)


class BotMemberTokenMixin(_BotMembers):
    def post(self, request, slug, bot_id):
        """A new access token (shown once); every earlier token of the bot stops working."""
        self.require_bot_admin()
        bot = self.get_bot()
        token = bot_members.rotate_token(bot)
        return Response(bot_payload(bot, token=token), status=status.HTTP_201_CREATED)
