/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EUserPermissions } from "@plane/constants";
// hooks
import { useUserPermissions } from "@/hooks/store/user";

export type TCodingAccess = {
  /** A project member or admin: may start and retry jobs and read the coding settings. */
  canWrite: boolean;
  /** A project admin or workspace admin: may cancel anyone's job. */
  isAdmin: boolean;
  /** May change the coding settings (reads them first, so also `canWrite`). */
  canEditSettings: boolean;
};

/**
 * What the coding endpoints allow this user, decided as `plane.coding.access` decides it. That uses the user's own
 * project role: unlike the permission store's project role, a workspace admin who is a guest in the project stays a
 * guest there (the API answers 403 to their start, cancel, retry and settings requests).
 */
export const useCodingAccess = (workspaceSlug: string, projectId: string): TCodingAccess => {
  const { workspaceProjectsPermissions, getWorkspaceRoleByWorkspaceSlug } = useUserPermissions();
  const projectRole = Number(workspaceProjectsPermissions?.[workspaceSlug]?.[projectId] ?? 0);
  const workspaceRole = Number(getWorkspaceRoleByWorkspaceSlug(workspaceSlug) ?? 0);
  const canWrite = projectRole >= EUserPermissions.MEMBER;
  // As `is_project_or_workspace_admin`: a workspace admin counts only while a member of the project.
  const isAdmin =
    projectRole === EUserPermissions.ADMIN || (projectRole > 0 && workspaceRole === EUserPermissions.ADMIN);
  return { canWrite, isAdmin, canEditSettings: canWrite && isAdmin };
};
