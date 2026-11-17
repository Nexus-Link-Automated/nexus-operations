# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The coding audit trail, for workspace admins."""

import uuid

from django.utils.dateparse import parse_datetime
from rest_framework.response import Response

from plane.coding.models import CodingAuditEvent

from .machine import _WorkspaceMachines

PAGE = 100


class CodingAuditMixin(_WorkspaceMachines):
    def get(self, request, slug):
        """Newest first, 100 at a time: pass `next_before` back as `before` for the next page. Filters: `action`
        (`job` or `job.started`), `actor`, `project`, `target` (ids)."""
        self.require_admin()
        events = CodingAuditEvent.objects.filter(workspace=self.workspace)
        errors = {}
        action = request.GET.get("action")
        if action:
            events = events.filter(action=action) if "." in action else events.filter(action__startswith=f"{action}.")
        for param, field in (("actor", "actor_id"), ("project", "project_id"), ("target", "target_id")):
            value = request.GET.get(param)
            if not value:
                continue
            try:
                events = events.filter(**{field: uuid.UUID(value)})
            except ValueError:
                errors[param] = ["Must be an id."]
        before = request.GET.get("before")
        if before:
            when = parse_datetime(before)
            if when is None:
                errors["before"] = ["Must be a date and time (ISO 8601)."]
            else:
                events = events.filter(created_at__lt=when)
        if errors:
            return self.invalid(errors)
        page = list(events.order_by("-created_at")[: PAGE + 1])
        results = [
            {
                "id": str(event.id),
                "action": event.action,
                "actor": str(event.actor_id) if event.actor_id else None,
                "actor_name": event.actor_name,
                "target_type": event.target_type,
                "target_id": str(event.target_id) if event.target_id else None,
                "project": str(event.project_id) if event.project_id else None,
                "details": event.details,
                "created_at": event.created_at,
            }
            for event in page[:PAGE]
        ]
        next_before = page[PAGE - 1].created_at.isoformat() if len(page) > PAGE else None
        return Response({"results": results, "next_before": next_before})
