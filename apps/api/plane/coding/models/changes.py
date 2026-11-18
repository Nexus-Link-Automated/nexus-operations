# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A finished job's changes on their way to a pull request.

The machine sends the files the job changed with its result. The CRM keeps them here only while it pushes the job's
branch and opens the pull request (`plane.coding.publish`); the row is removed as soon as that ends, either way.
"""

from django.db import models

from plane.db.models import BaseModel

__all__ = ["CodingJobChanges"]


class CodingJobChanges(BaseModel):
    job = models.OneToOneField("coding.CodingJob", on_delete=models.CASCADE, related_name="changes")
    # The commit the job's clone started from; the pull request's commit has it as its parent.
    base_commit = models.CharField(max_length=40)
    # `[{"path", "mode", "content"}]` (content base64) or `[{"path", "deleted": true}]`.
    files = models.JSONField(default=list)
    # The machine's validated result, applied once the pull request is open.
    result = models.JSONField(default=dict)

    class Meta:
        db_table = "coding_job_changes"
