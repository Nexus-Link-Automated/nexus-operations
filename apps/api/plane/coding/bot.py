# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The per-workspace "Coding agent" bot user that authors outcome comments and state changes.

It is created on first use and is not a workspace member: it cannot sign in (bots are refused at sign-in), has no
password anyone knows, gets no notification preferences (`create_user_notification` skips bots), and appears in no
member list. The web app names a bot comment author from the comment itself.

Its email address is random and on a reserved domain (`.invalid` never resolves), so no one can register it first.
"""

import uuid

from django.contrib.auth.hashers import make_password
from django.db import IntegrityError, transaction

from plane.db.models import User

BOT_TYPE = "coding_agent"
BOT_NAME = "Coding agent"
BOT_EMAIL_DOMAIN = "coding-agent.invalid"


class BotUnavailable(RuntimeError):
    """The bot's username is held by an account that is not the bot."""


def _find(username: str) -> User | None:
    user = User.objects.filter(username=username).first()
    if user is not None and not (user.is_bot and user.bot_type == BOT_TYPE):
        raise BotUnavailable(f"The username {username} belongs to an account that is not the coding agent bot.")
    return user


def coding_bot(workspace) -> User:
    username = f"coding_agent_{workspace.id.hex}"
    bot = _find(username)
    if bot is not None:
        return bot
    try:
        with transaction.atomic():
            return User.objects.create(
                username=username,
                email=f"{uuid.uuid4().hex}@{BOT_EMAIL_DOMAIN}",
                display_name=BOT_NAME,
                first_name=BOT_NAME,
                last_name="",
                is_bot=True,
                bot_type=BOT_TYPE,
                password=make_password(uuid.uuid4().hex),
                is_password_autoset=True,
            )
    except IntegrityError:
        # Another request created it first.
        bot = _find(username)
        if bot is None:
            raise
        return bot
