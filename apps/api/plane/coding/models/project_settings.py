# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Per-project coding settings: on or off, the repository, and which columns the outcomes move work items to.

A project without a row has coding jobs off. Each outcome column is a state of the same project; when one is unset
(or its state was deleted), the state with the default name is used, matched case-insensitively
(`plane.coding.columns.resolve_column`).
"""

from django.db import models

from plane.db.models import BaseModel

__all__ = ["ProjectCodingSettings"]


class ProjectCodingSettings(BaseModel):
    workspace = models.ForeignKey("db.Workspace", on_delete=models.CASCADE, related_name="coding_settings")
    project = models.OneToOneField("db.Project", on_delete=models.CASCADE, related_name="coding_settings")
    enabled = models.BooleanField(default=False)
    repo_url = models.CharField(max_length=500, blank=True, default="")
    default_branch = models.CharField(max_length=255, default="main")
    ready_state = models.ForeignKey("db.State", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    failed_state = models.ForeignKey("db.State", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    in_review_state = models.ForeignKey("db.State", on_delete=models.SET_NULL, null=True, blank=True, related_name="+")

    class Meta:
        db_table = "coding_project_settings"

    @property
    def is_configured(self) -> bool:
        return self.enabled and bool(self.repo_url)

    def save(self, *args, **kwargs):
        self.workspace_id = self.project.workspace_id
        super().save(*args, **kwargs)
