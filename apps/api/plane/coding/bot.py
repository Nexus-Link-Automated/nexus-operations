# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The per-workspace "Coding agent" bot user that authors outcome comments and state changes.

It is created on first use and is not a workspace member: it cannot sign in (bots are refused at sign-in), has no
password anyone knows, gets no notification preferences (`create_user_notification` skips bots), and appears in no
member list. The web app shows a bot comment author by the bot's own name.
"""

import uuid
from urllib.parse import urlparse

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import IntegrityError, transaction

from plane.db.models import User

BOT_TYPE = "coding_agent"
BOT_NAME = "Coding agent"


def coding_bot(workspace) -> User:
    username = f"coding_agent_{workspace.id.hex}"
    bot = User.objects.filter(username=username).first()
    if bot is not None:
        return bot
    host = urlparse(settings.WEB_URL or "").hostname or "plane.so"
    try:
        with transaction.atomic():
            return User.objects.create(
                username=username,
                email=f"{username}@{host}",
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
        return User.objects.get(username=username)
