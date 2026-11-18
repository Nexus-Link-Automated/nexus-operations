# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from rest_framework import serializers

from plane.coding.bot_members import BOT_ROLES, membership
from plane.coding.serializers.base import StrictSerializer
from plane.db.models import APIToken


def bot_payload(bot, **extra) -> dict:
    member = membership(bot)
    token = APIToken.objects.filter(user_id=bot.user_id, is_active=True).order_by("-created_at").first()
    return {
        "id": str(bot.user_id),
        "name": bot.user.first_name,
        "display_name": bot.user.display_name,
        "description": bot.description,
        "role": member.role if member else None,
        "is_active": bool(member and member.is_active),
        "created_by": str(bot.created_by_id) if bot.created_by_id else None,
        "created_at": bot.created_at,
        "token_created_at": token.created_at if token else None,
        "token_last_used": token.last_used if token else None,
        **extra,
    }


class BotCreateSerializer(StrictSerializer):
    name = serializers.CharField(max_length=60)
    role = serializers.ChoiceField(choices=BOT_ROLES, default=15)
    description = serializers.CharField(max_length=2000, required=False, allow_blank=True, default="")


class BotUpdateSerializer(StrictSerializer):
    name = serializers.CharField(max_length=60, required=False)
    role = serializers.ChoiceField(choices=BOT_ROLES, required=False)
    description = serializers.CharField(max_length=2000, required=False, allow_blank=True)
