# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""EmployAI agents as bot members of a workspace (Step 7 of the coding jobs plan).

A workspace admin creates a bot member with a name, a role (member or guest; never admin) and what it is for. The bot
is a `User` with `is_bot` and `bot_type` `EMPLOYAI`, a `WorkspaceMember` with that role, and an access token scoped to
the workspace, shown once. It cannot sign in to the web app (no password, an address nobody receives mail at); it uses
the CRM only through the public API and MCP, with its token, as an ordinary member: project admins add it to projects,
its role is changed and it is removed from the members list like anyone (removal also ends its tokens).

Its coding jobs run on its own machines, never a person's: a workspace admin adds and approves them for it
(`plane.coding.machines`), and the bot itself can do neither.
"""

import secrets

from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.coding.exceptions import CodingError, Conflict, NotFound
from plane.coding.models import BOT_TYPE, MAX_BOTS_PER_WORKSPACE, BotMember
from plane.db.models import APIToken, ProjectMember, User, WorkspaceMember
from plane.utils.agent_credentials import end_agent_access

__all__ = ["BOT_ROLES", "create_bot", "is_employai_bot", "remove_bot", "rotate_token", "update_bot"]

GUEST, MEMBER = 5, 15
BOT_ROLES = (GUEST, MEMBER)
TOKEN_LABEL = "EmployAI bot member"


def is_employai_bot(user) -> bool:
    return bool(user and user.is_bot and user.bot_type == BOT_TYPE)


def _token(bot_user, workspace) -> str:
    token = APIToken.objects.create(
        user=bot_user,
        user_type=1,
        workspace=workspace,
        label=TOKEN_LABEL,
        description=f"Access token of the bot member {bot_user.first_name}",
    )
    return token.token


def create_bot(workspace, name: str, role: int, description: str = "") -> tuple[BotMember, str]:
    """A new bot member and its token (the only time it is shown)."""
    if role not in BOT_ROLES:
        raise CodingError("A bot member is a member or a guest.", code="BOT_ROLE_NOT_ALLOWED")
    active = WorkspaceMember.objects.filter(
        workspace=workspace, member__is_bot=True, member__bot_type=BOT_TYPE, is_active=True
    ).count()
    if active >= MAX_BOTS_PER_WORKSPACE:
        raise Conflict(f"A workspace has at most {MAX_BOTS_PER_WORKSPACE} bot members.", code="BOT_LIMIT")
    suffix = secrets.token_hex(8)
    with transaction.atomic():
        try:
            user = User.objects.create(
                username=f"employai_{suffix}",
                # Never receives mail: the bot cannot sign in with a magic code.
                email=f"employai-{suffix}@bot-member.invalid",
                first_name=name,
                display_name=f"{name[:60]}-bot-{suffix[:4]}".replace(" ", "-").lower(),
                is_bot=True,
                bot_type=BOT_TYPE,
                is_password_autoset=True,
            )
        except IntegrityError:  # pragma: no cover - 64 random bits
            raise CodingError("Could not create the bot member. Try again.")
        user.set_unusable_password()
        user.save(update_fields=["password"])
        WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
        bot = BotMember.objects.create(workspace=workspace, user=user, description=description)
        token = _token(user, workspace)
    return bot, token


def get_bot(workspace, bot_id) -> BotMember:
    bot = BotMember.objects.select_related("user").filter(workspace=workspace, user_id=bot_id).first()
    if bot is None:
        raise NotFound("Bot member not found.")
    return bot


def membership(bot: BotMember):
    return WorkspaceMember.objects.filter(workspace_id=bot.workspace_id, member_id=bot.user_id).first()


def update_bot(bot: BotMember, *, name: str | None = None, description: str | None = None, role: int | None = None):
    member = membership(bot)
    if member is None or not member.is_active:
        raise Conflict("This bot member was removed.", code="BOT_REMOVED")
    with transaction.atomic():
        if name is not None:
            bot.user.first_name = name
            bot.user.save(update_fields=["first_name"])
        if description is not None:
            bot.description = description
            bot.save(update_fields=["description", "updated_at"])
        if role is not None:
            if role not in BOT_ROLES:
                raise CodingError("A bot member is a member or a guest.", code="BOT_ROLE_NOT_ALLOWED")
            if role == GUEST:
                # A guest holds no other project role, as for people.
                ProjectMember.objects.filter(workspace_id=bot.workspace_id, member_id=bot.user_id).update(
                    role=GUEST, updated_at=timezone.now()
                )
            member.role = role
            member.save(update_fields=["role", "updated_at"])
    return bot


def rotate_token(bot: BotMember) -> str:
    """Ends every token the bot has and gives it a new one (shown once)."""
    member = membership(bot)
    if member is None or not member.is_active:
        raise Conflict("This bot member was removed.", code="BOT_REMOVED")
    with transaction.atomic():
        APIToken.objects.filter(user_id=bot.user_id, is_active=True).update(is_active=False, updated_at=timezone.now())
        return _token(bot.user, bot.workspace)


def remove_bot(bot: BotMember) -> None:
    """What removing any member does: off every project and the workspace; its tokens end too."""
    with transaction.atomic():
        ProjectMember.objects.filter(workspace_id=bot.workspace_id, member_id=bot.user_id, is_active=True).update(
            is_active=False, updated_at=timezone.now()
        )
        WorkspaceMember.objects.filter(workspace_id=bot.workspace_id, member_id=bot.user_id).update(
            is_active=False, updated_at=timezone.now()
        )
        end_agent_access([(bot.workspace_id, bot.user_id)])
