# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.apps import AppConfig


class CodingConfig(AppConfig):
    """Coding jobs: a coding agent fixes a bug or writes a test for a work item, and the CRM applies the outcome."""

    name = "plane.coding"
    label = "coding"
    default_auto_field = "django.db.models.BigAutoField"
