# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Who may see and do what with coding jobs. Shared by the public API and the web app's routes.

- Not an active member of the workspace in the URL: 403 (the view's permission class), as everywhere in Plane.
- A project, work item or job id that is not in that workspace (or project, or work item): 404.
- Not an active member of the project: 403, as Plane's project permissions answer.
- Guests see jobs only on work items they can see (a restricted guest only on the ones they created; any other is
  404, as for the work item itself), and cannot start, cancel or retry them.
- Members and admins start and retry jobs. Cancel needs the person who started the job or a project admin.
- Project coding settings: members and admins read them, project admins change them.
"""

from dataclasses import dataclass
from functools import cached_property

from plane.api.views.issue import guest_cannot_view_issue, is_project_or_workspace_admin
from plane.app.permissions.base import ROLE
from plane.coding.exceptions import Forbidden, NotFound
from plane.db.models import Issue, Project, ProjectMember


@dataclass
class ProjectAccess:
    user: object
    slug: str
    project: Project
    role: int

    @property
    def can_write(self) -> bool:
        return self.role >= ROLE.MEMBER.value

    @cached_property
    def is_admin(self) -> bool:
        return is_project_or_workspace_admin(self.user.id, self.project.id, self.slug)

    def require_write(self):
        if not self.can_write:
            raise Forbidden("Guests cannot start, cancel or retry coding jobs.")

    def require_admin(self):
        if not self.is_admin:
            raise Forbidden("Only project admins can change coding settings.")

    def require_reader_of_settings(self):
        if not self.can_write:
            raise Forbidden("Guests cannot see coding settings.")

    def visible_issue(self, issue_id) -> Issue:
        issue = Issue.objects.filter(pk=issue_id, project=self.project).first()
        if issue is None or guest_cannot_view_issue(self.user.id, issue, self.slug):
            raise NotFound("Work item not found.")
        return issue


def project_access(user, slug: str, project_id) -> ProjectAccess:
    project = Project.objects.filter(pk=project_id, workspace__slug=slug, archived_at__isnull=True).first()
    if project is None:
        raise NotFound("Project not found.")
    role = (
        ProjectMember.objects.filter(project=project, member=user, is_active=True)
        .values_list("role", flat=True)
        .first()
    )
    if role is None:
        raise Forbidden("You are not a member of this project.")
    return ProjectAccess(user=user, slug=slug, project=project, role=role)
