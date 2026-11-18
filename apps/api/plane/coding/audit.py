# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Writing and reading the coding audit trail (`models/audit.py`). Writing never fails the action it records."""

import logging

from django.db import transaction

from plane.coding.models import CodingAuditEvent

logger = logging.getLogger("plane.coding")

__all__ = ["record"]

DETAIL_TEXT_MAX = 500


def _name(user) -> str:
    if user is None:
        return ""
    if user.is_bot:
        return f"{user.first_name} (bot)"
    return user.display_name or f"{user.first_name} {user.last_name}".strip()


def _clean(details: dict) -> dict:
    clean = {}
    for key, value in details.items():
        if value is None:
            continue
        clean[key] = value[:DETAIL_TEXT_MAX] if isinstance(value, str) else value
    return clean


def record(
    workspace_id,
    action: str,
    target_type: str,
    target_id=None,
    *,
    actor=None,
    actor_name="",
    project_id=None,
    **details,
) -> None:
    """Note what happened. `actor` is the person or bot; without one, `actor_name` says who (a machine, the CRM)."""
    try:
        # Its own savepoint: a failed write here never breaks the caller's transaction.
        with transaction.atomic():
            _create(workspace_id, action, target_type, target_id, actor, actor_name, project_id, details)
    except Exception:  # pragma: no cover - the trail never breaks what it records
        logger.exception("coding: could not record %s in the audit trail", action)


def _create(workspace_id, action, target_type, target_id, actor, actor_name, project_id, details):
    CodingAuditEvent.objects.create(
        workspace_id=workspace_id,
        actor=actor if actor is not None and getattr(actor, "pk", None) else None,
        actor_name=(_name(actor) if actor is not None else actor_name)[:255],
        action=action,
        target_type=target_type,
        target_id=target_id,
        project_id=project_id,
        details=_clean(details),
    )
