# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db import connection

PARENT_CYCLE_ERROR = "A work item cannot be its own parent or have one of its sub-work items as its parent"

# UNION, not UNION ALL, so a loop already in the data ends the walk instead of repeating it.
_ANCESTORS_SQL = """
WITH RECURSIVE ancestors AS (
    SELECT parent_id AS id FROM issues WHERE id = %s AND parent_id IS NOT NULL
    UNION
    SELECT issues.parent_id FROM issues JOIN ancestors ON issues.id = ancestors.id
    WHERE issues.parent_id IS NOT NULL
)
SELECT id FROM ancestors
"""

_DESCENDANTS_SQL = """
WITH RECURSIVE descendants AS (
    SELECT id FROM issues WHERE parent_id = %s
    UNION
    SELECT issues.id FROM issues JOIN descendants ON issues.parent_id = descendants.id
)
SELECT id FROM descendants
"""


def _ids(sql, issue_id):
    with connection.cursor() as cursor:
        cursor.execute(sql, [str(issue_id)])
        return {str(row[0]) for row in cursor.fetchall()}


def get_ancestor_ids(issue_id):
    """Ids of every work item above this one, following parent links."""
    return _ids(_ANCESTORS_SQL, issue_id)


def get_descendant_ids(issue_id):
    """Ids of every work item below this one, following parent links."""
    return _ids(_DESCENDANTS_SQL, issue_id)


def creates_parent_cycle(issue_id, parent_id):
    """True when making parent_id the parent of issue_id would form a loop.

    That is the case when the parent is the work item itself or one of its descendants,
    which is the same as the work item being the parent or one of the parent's ancestors.
    Soft-deleted rows are followed too, since their parent links are still stored.
    """
    if issue_id is None or parent_id is None:
        return False
    issue_id = str(issue_id)
    return issue_id == str(parent_id) or issue_id in get_ancestor_ids(parent_id)
