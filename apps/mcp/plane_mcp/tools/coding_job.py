"""Coding jobs on a work item: a coding agent fixes the bug or writes a test, and the CRM applies the outcome."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from fastmcp import FastMCP
from plane.api.base_resource import BaseResource
from plane.errors.errors import HttpError

from plane_mcp.client import get_plane_client_context
from plane_mcp.toolkit import Action, build_annotations, build_description, needs, one_of, page_params

NAME = "coding_job"
TITLE = "Coding jobs"

JOB_ACTIONS = ("fix_bug", "write_test", "write_and_run_test")
AGENTS = ("codex", "claude")
STATUSES = ("queued", "running", "needs_input", "finished", "cancelled")

ACTIONS = (
    Action("list", ("project_id", "workitem_id"), ("status", "job_action", "cursor", "per_page"), read=True),
    Action("get", ("project_id", "workitem_id", "job_id"), read=True),
    Action("events", ("project_id", "workitem_id", "job_id"), ("after",), read=True, note="progress lines after seq"),
    Action("start", ("project_id", "workitem_id", "job_action", "agent"), ("machine",)),
    Action("cancel", ("project_id", "workitem_id", "job_id"), note="the person who started it or a project admin"),
    Action(
        "retry",
        ("project_id", "workitem_id", "job_id"),
        ("agent", "machine"),
        note="only a cancelled or job_error job; starts a new job",
    ),
    Action(
        "answer",
        ("project_id", "workitem_id", "job_id", "text"),
        note="a needs_input job's open question",
    ),
    Action("settings_get", ("project_id",), read=True),
    Action(
        "settings_update",
        ("project_id",),
        ("enabled", "repo_url", "default_branch", "ready_state_id", "failed_state_id", "in_review_state_id"),
        note="project admins; only what you pass changes",
    ),
    Action("repository", ("project_id",), read=True, note="can jobs open pull requests"),
)

FOOTER = (
    f"job_action: {', '.join(JOB_ACTIONS)}. agent: {', '.join(AGENTS)}. "
    'machine: one of your approved coding_machine ids, or "auto"; omitted, start uses auto and retry keeps the '
    "job's machine if still allowed. "
    "The CRM moves the work item and comments when one ends: fixed -> In review, test_written or test_passed -> "
    "Ready, bug_found -> Failed; could_not_fix and job_error leave it. One active job per work item and job_action. "
    'A state id set to "none" goes back to matching the column by name; repo_url "none" clears it.'
)

LEGACY: dict[str, str] = {}


class CodingJobs(BaseResource):
    """The coding-job endpoints, which plane-sdk does not cover: same base URL, session and auth as its resources."""

    def __init__(self, config: Any) -> None:
        super().__init__(config, "/workspaces/")

    @staticmethod
    def _jobs(workspace_slug: str, project_id: str, work_item_id: str) -> str:
        return f"{workspace_slug}/projects/{project_id}/work-items/{work_item_id}/coding-jobs"

    def list(
        self, workspace_slug: str, project_id: str, work_item_id: str, params: Mapping[str, Any] | None = None
    ) -> Any:
        return self._get(self._jobs(workspace_slug, project_id, work_item_id), params=params)

    def retrieve(self, workspace_slug: str, project_id: str, work_item_id: str, job_id: str) -> Any:
        return self._get(f"{self._jobs(workspace_slug, project_id, work_item_id)}/{job_id}")

    def create(self, workspace_slug: str, project_id: str, work_item_id: str, data: Mapping[str, Any]) -> Any:
        return self._post(self._jobs(workspace_slug, project_id, work_item_id), data)

    def events(
        self, workspace_slug: str, project_id: str, work_item_id: str, job_id: str, params: Mapping[str, Any]
    ) -> Any:
        return self._get(f"{self._jobs(workspace_slug, project_id, work_item_id)}/{job_id}/events", params=params)

    def cancel(self, workspace_slug: str, project_id: str, work_item_id: str, job_id: str) -> Any:
        return self._post(f"{self._jobs(workspace_slug, project_id, work_item_id)}/{job_id}/cancel")

    def retry(
        self, workspace_slug: str, project_id: str, work_item_id: str, job_id: str, data: Mapping[str, Any]
    ) -> Any:
        return self._post(f"{self._jobs(workspace_slug, project_id, work_item_id)}/{job_id}/retry", data)

    def answer(
        self, workspace_slug: str, project_id: str, work_item_id: str, job_id: str, data: Mapping[str, Any]
    ) -> Any:
        return self._post(f"{self._jobs(workspace_slug, project_id, work_item_id)}/{job_id}/answer", data)

    def get_settings(self, workspace_slug: str, project_id: str) -> Any:
        return self._get(f"{workspace_slug}/projects/{project_id}/coding-settings")

    def update_settings(self, workspace_slug: str, project_id: str, data: Mapping[str, Any]) -> Any:
        return self._patch(f"{workspace_slug}/projects/{project_id}/coding-settings", data)

    def repository(self, workspace_slug: str, project_id: str) -> Any:
        return self._get(f"{workspace_slug}/projects/{project_id}/coding-settings/repository")


def coding_jobs(client: Any) -> CodingJobs:
    return CodingJobs(client.config)


def _refusal(exc: HttpError) -> str | None:
    """The API's own reason for a refusal it expects callers to act on (409 JOB_ACTIVE, 400 CODING_NOT_CONFIGURED)."""
    body = exc.response
    if exc.status_code not in (400, 403, 404, 409) or not isinstance(body, dict) or "error" not in body:
        return None
    message = f"Error: {body['error']}"
    if body.get("code"):
        message += f" ({body['code']})"
    if body.get("errors"):
        message += f" {body['errors']}"
    if body.get("job_id"):
        message += f" job_id={body['job_id']}"
    return message


def _machine(value: str) -> dict[str, str | None]:
    """The job's machine: left out ("") sends nothing, so the API's default applies; "auto" sends null (Auto)."""
    if not value:
        return {}
    return {"machine": None if value.lower() == "auto" else value}


def _state(value: str) -> str | None:
    return None if value.lower() == "none" else value


def register(mcp: FastMCP) -> None:
    @mcp.tool(
        name=NAME,
        description=build_description("Coding jobs on a work item, and a project's coding settings.", ACTIONS, FOOTER),
        annotations=build_annotations(TITLE, ACTIONS),
    )
    def coding_job(
        action: Literal[
            "list",
            "get",
            "events",
            "start",
            "cancel",
            "retry",
            "answer",
            "settings_get",
            "settings_update",
            "repository",
        ],
        project_id: str = "",
        workitem_id: str = "",
        job_id: str = "",
        job_action: str = "",
        agent: str = "",
        machine: str = "",
        status: str = "",
        # False switches coding jobs off, so unset is None rather than False.
        enabled: bool | None = None,
        repo_url: str = "",
        default_branch: str = "",
        ready_state_id: str = "",
        failed_state_id: str = "",
        in_review_state_id: str = "",
        text: str = "",
        cursor: str = "",
        per_page: int = 0,
        after: int = 0,
    ) -> dict[str, Any] | str:
        if error := (
            one_of("job_action", job_action, JOB_ACTIONS)
            or one_of("agent", agent, AGENTS)
            or one_of("status", status, STATUSES)
        ):
            return error
        if error := needs(action, project_id=project_id):
            return error
        client, workspace_slug = get_plane_client_context()
        api = coding_jobs(client)
        try:
            if action == "settings_get":
                return api.get_settings(workspace_slug, project_id)
            if action == "repository":
                return api.repository(workspace_slug, project_id)
            if action == "settings_update":
                data: dict[str, Any] = {}
                if enabled is not None:
                    data["enabled"] = enabled
                if repo_url:
                    data["repo_url"] = "" if repo_url.lower() == "none" else repo_url
                if default_branch:
                    data["default_branch"] = default_branch
                for key, value in (
                    ("ready_state", ready_state_id),
                    ("failed_state", failed_state_id),
                    ("in_review_state", in_review_state_id),
                ):
                    if value:
                        data[key] = _state(value)
                if not data:
                    return "Error: action 'settings_update' needs at least one setting to change."
                return api.update_settings(workspace_slug, project_id, data)

            if error := needs(action, workitem_id=workitem_id):
                return error
            if action == "list":
                params = page_params(cursor, per_page, status=status, action=job_action)
                return api.list(workspace_slug, project_id, workitem_id, params=params)
            if action == "start":
                if error := needs(action, job_action=job_action, agent=agent):
                    return error
                data = {"action": job_action, "agent": agent, **_machine(machine)}
                return api.create(workspace_slug, project_id, workitem_id, data)

            if error := needs(action, job_id=job_id):
                return error
            if action == "get":
                return api.retrieve(workspace_slug, project_id, workitem_id, job_id)
            if action == "events":
                params = {"after": after} if after > 0 else {}
                return api.events(workspace_slug, project_id, workitem_id, job_id, params)
            if action == "cancel":
                return api.cancel(workspace_slug, project_id, workitem_id, job_id)
            if action == "answer":
                if error := needs(action, text=text):
                    return error
                return api.answer(workspace_slug, project_id, workitem_id, job_id, {"text": text})
            data = {"agent": agent} if agent else {}
            return api.retry(workspace_slug, project_id, workitem_id, job_id, {**data, **_machine(machine)})
        except HttpError as exc:
            if refusal := _refusal(exc):
                return refusal
            raise
