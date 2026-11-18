"""Bot members: EmployAI agents in the workspace as bot users with a role and their own access token."""

from __future__ import annotations

from typing import Any, Literal

from fastmcp import FastMCP
from plane.api.base_resource import BaseResource
from plane.errors.errors import HttpError

from plane_mcp.client import get_plane_client_context
from plane_mcp.toolkit import Action, build_annotations, build_description, needs, one_of
from plane_mcp.tools.coding_job import _refusal

NAME = "bot_member"
TITLE = "Bot members"

ROLES = {"member": 15, "guest": 5}

ACTIONS = (
    Action("list", read=True),
    Action("get", ("bot_id",), read=True),
    Action(
        "create", ("name",), ("role", "description"), note="returns token, shown once: hand it over, never store it"
    ),
    Action("update", ("bot_id",), ("name", "role", "description")),
    Action("new_token", ("bot_id",), note="ends its earlier tokens; returns token once"),
    Action("remove", ("bot_id",), destructive=True, note="off the workspace and its projects; tokens end"),
)

# Kept short: the whole listing has a size budget (tests/tools/test_conformance.py).
FOOTER = "Workspace admins only. role: member (default) or guest. Add a bot to projects as any member."

LEGACY: dict[str, str] = {}


class BotMembers(BaseResource):
    def __init__(self, config: Any) -> None:
        super().__init__(config, "/workspaces/")

    def list(self, workspace_slug: str) -> Any:
        return self._get(f"{workspace_slug}/bot-members")

    def retrieve(self, workspace_slug: str, bot_id: str) -> Any:
        return self._get(f"{workspace_slug}/bot-members/{bot_id}")

    def create(self, workspace_slug: str, data: dict[str, Any]) -> Any:
        return self._post(f"{workspace_slug}/bot-members", data)

    def update(self, workspace_slug: str, bot_id: str, data: dict[str, Any]) -> Any:
        return self._patch(f"{workspace_slug}/bot-members/{bot_id}", data)

    def new_token(self, workspace_slug: str, bot_id: str) -> Any:
        return self._post(f"{workspace_slug}/bot-members/{bot_id}/token")

    def delete(self, workspace_slug: str, bot_id: str) -> None:
        self._delete(f"{workspace_slug}/bot-members/{bot_id}")


def bot_members(client: Any) -> BotMembers:
    return BotMembers(client.config)


def register(mcp: FastMCP) -> None:
    @mcp.tool(
        name=NAME,
        description=build_description("EmployAI agents as bot members of the workspace.", ACTIONS, FOOTER),
        annotations=build_annotations(TITLE, ACTIONS),
    )
    def bot_member(
        action: Literal["list", "get", "create", "update", "new_token", "remove"],
        bot_id: str = "",
        name: str = "",
        role: str = "",
        description: str | None = None,
    ) -> dict[str, Any] | list[dict[str, Any]] | str | None:
        if error := one_of("role", role, tuple(ROLES)):
            return error
        if action == "create":
            error = needs(action, name=name)
        elif action != "list":
            error = needs(action, bot_id=bot_id)
        if error:
            return error
        data: dict[str, Any] = {}
        if name:
            data["name"] = name
        if role:
            data["role"] = ROLES[role]
        if description is not None:
            data["description"] = description
        client, workspace_slug = get_plane_client_context()
        api = bot_members(client)
        try:
            if action == "list":
                return api.list(workspace_slug)
            if action == "get":
                return api.retrieve(workspace_slug, bot_id)
            if action == "create":
                return api.create(workspace_slug, data)
            if action == "update":
                if not data:
                    return "Error: action 'update' needs a name, role or description."
                return api.update(workspace_slug, bot_id, data)
            if action == "new_token":
                return api.new_token(workspace_slug, bot_id)
            api.delete(workspace_slug, bot_id)
            return None
        except HttpError as exc:
            if refusal := _refusal(exc):
                return refusal
            raise
