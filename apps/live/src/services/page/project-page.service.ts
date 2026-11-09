/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { logger } from "@plane/logger";
import { AppError } from "@/lib/errors";
import { PageService } from "./extended.service";

interface ProjectPageServiceParams {
  workspaceSlug: string | null;
  projectId: string | null;
  cookie: string | null;
  [key: string]: unknown;
}

export class ProjectPageService extends PageService {
  protected basePath: string;

  constructor(params: ProjectPageServiceParams) {
    super();
    const { workspaceSlug, projectId } = params;
    if (!workspaceSlug || !projectId) throw new AppError("Missing required fields.");
    // validate cookie
    if (!params.cookie) throw new AppError("Cookie is required.");
    // set cookie
    this.setHeader("Cookie", params.cookie);
    // set base path
    this.basePath = `/api/workspaces/${workspaceSlug}/projects/${projectId}`;
  }

  /**
   * Fetches the role of the user whose cookie this service uses, in this project
   */
  async fetchCurrentUserRole(): Promise<number> {
    try {
      const response = await this.get(`${this.basePath}/project-members/me/`, {
        headers: this.getHeader(),
      });
      return response?.data?.role as number;
    } catch (error) {
      const appError = new AppError(error, { context: { operation: "fetchCurrentUserRole" } });
      logger.error("Failed to fetch project role", appError);
      throw appError;
    }
  }
}
