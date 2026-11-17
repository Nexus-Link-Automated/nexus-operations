"""Machines: a person's own computers that run their coding jobs, and the workspace admins' view of every one."""

from __future__ import annotations

from typing import Any, Literal

from fastmcp import FastMCP
from plane.api.base_resource import BaseResource
from plane.errors.errors import HttpError

from plane_mcp.client import get_plane_client_context
from plane_mcp.toolkit import Action, build_annotations, build_description, needs
from plane_mcp.tools.coding_job import _refusal

NAME = "coding_machine"
TITLE = "Coding machines"

ACTIONS = (
    Action("list", read=True, note="yours"),
    Action("list_all", read=True, note="workspace admins; all machines"),
    Action("get", ("machine_id",), read=True, note="yours, or any for an admin"),
    Action(
        "add",
        ("name",),
        note="returns join_code, shown once: pass it to the machine service's join command, never store it; "
        "single use, 30 min",
    ),
    Action("rename", ("machine_id", "name"), note="the owner"),
    Action("approve", ("machine_id",), note="the owner, after it joins"),
    Action("remove", ("machine_id",), destructive=True, note="the owner; for good"),
    Action("revoke", ("machine_id",), destructive=True, note="workspace admins"),
)

# Kept short: the whole listing has a size budget (tests/tools/test_conformance.py).
FOOTER = (
    "state: pending -> awaiting_approval (joined; check hostname, then approve) -> active; revoked is final. "
    "At most 20 per person; guests have none."
)

LEGACY: dict[str, str] = {}


class CodingMachines(BaseResource):
    """The machine endpoints people call, which plane-sdk does not cover. The machine's own join and heartbeat are
    for the machine service and are deliberately absent."""

    def __init__(self, config: Any) -> None:
        super().__init__(config, "/workspaces/")

    def list(self, workspace_slug: str) -> Any:
        return self._get(f"{workspace_slug}/coding-machines")

    def list_all(self, workspace_slug: str) -> Any:
        return self._get(f"{workspace_slug}/coding-machines/all")

    def retrieve(self, workspace_slug: str, machine_id: str) -> Any:
        return self._get(f"{workspace_slug}/coding-machines/{machine_id}")

    def create(self, workspace_slug: str, name: str) -> Any:
        return self._post(f"{workspace_slug}/coding-machines", {"name": name})

    def rename(self, workspace_slug: str, machine_id: str, name: str) -> Any:
        return self._patch(f"{workspace_slug}/coding-machines/{machine_id}", {"name": name})

    def delete(self, workspace_slug: str, machine_id: str) -> None:
        self._delete(f"{workspace_slug}/coding-machines/{machine_id}")

    def approve(self, workspace_slug: str, machine_id: str) -> Any:
        return self._post(f"{workspace_slug}/coding-machines/{machine_id}/approve")

    def revoke(self, workspace_slug: str, machine_id: str) -> Any:
        return self._post(f"{workspace_slug}/coding-machines/{machine_id}/revoke")


def coding_machines(client: Any) -> CodingMachines:
    return CodingMachines(client.config)


def register(mcp: FastMCP) -> None:
    @mcp.tool(
        name=NAME,
        description=build_description("Your own computers that run your coding jobs.", ACTIONS, FOOTER),
        annotations=build_annotations(TITLE, ACTIONS),
    )
    def coding_machine(
        action: Literal["list", "list_all", "get", "add", "rename", "approve", "remove", "revoke"],
        machine_id: str = "",
        name: str = "",
    ) -> dict[str, Any] | list[dict[str, Any]] | str | None:
        name = name.strip()
        if action == "add":
            error = needs(action, name=name)
        elif action == "rename":
            error = needs(action, machine_id=machine_id, name=name)
        elif action not in ("list", "list_all"):
            error = needs(action, machine_id=machine_id)
        else:
            error = None
        if error:
            return error
        client, workspace_slug = get_plane_client_context()
        api = coding_machines(client)
        try:
            if action == "list":
                return api.list(workspace_slug)
            if action == "list_all":
                return api.list_all(workspace_slug)
            if action == "add":
                return api.create(workspace_slug, name)
            if action == "get":
                return api.retrieve(workspace_slug, machine_id)
            if action == "rename":
                return api.rename(workspace_slug, machine_id, name)
            if action == "approve":
                return api.approve(workspace_slug, machine_id)
            if action == "revoke":
                return api.revoke(workspace_slug, machine_id)
            api.delete(workspace_slug, machine_id)
            return None
        except HttpError as exc:
            if refusal := _refusal(exc):
                return refusal
            raise
