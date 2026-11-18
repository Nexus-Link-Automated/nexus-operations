# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Which state ("column") of a project each outcome column means."""

from django.db import models

from plane.db.models import State

__all__ = ["Column", "resolve_column", "resolve_columns"]


class Column(models.TextChoices):
    """The outcome columns, with the state name each one matches when the project has not chosen a state."""

    READY = "ready", "Ready"
    FAILED = "failed", "Failed"
    IN_REVIEW = "in_review", "In review"


_SETTING_FIELD = {
    Column.READY: "ready_state_id",
    Column.FAILED: "failed_state_id",
    Column.IN_REVIEW: "in_review_state_id",
}


def resolve_column(project_id, coding_settings, column: Column):
    """`(state, chosen)`: the project's state for `column`, and whether the project chose it (else matched by name).

    `state` is None when the project chose none and has no state of that name. A chosen state that has since been
    deleted counts as unset. `State.objects` leaves out deleted and triage states.
    """
    states = State.objects.filter(project_id=project_id)
    chosen_id = getattr(coding_settings, _SETTING_FIELD[column]) if coding_settings is not None else None
    if chosen_id:
        state = states.filter(pk=chosen_id).first()
        if state is not None:
            return state, True
    return states.filter(name__iexact=column.label).order_by("sequence", "created_at").first(), False


def resolve_columns(project_id, coding_settings) -> dict:
    return {column.value: resolve_column(project_id, coding_settings, column) for column in Column}
