/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { AppError } from "@/lib/errors";

export const WORKSPACE_SLUG = "acme";
export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const PAGE_ID = "33333333-3333-4333-8333-333333333333";

export const ROLE = { ADMIN: 20, MEMBER: 15, GUEST: 5 } as const;

export type TFakePage = {
  id: string;
  projectId: string;
  ownedBy: string;
  isPrivate?: boolean;
  isLocked?: boolean;
  archivedAt?: string | null;
};

export const cookieFor = (userId: string) => `session=${userId}`;
export const tokenFor = (userId: string) => JSON.stringify({ id: userId, cookie: cookieFor(userId) });

/**
 * Stands in for the API over `APIService.get`, applying the same rules as ProjectPagePermission.
 */
export class FakePageApi {
  readonly pages = new Map<string, TFakePage>();
  readonly requests: { url: string; params?: Record<string, unknown> }[] = [];
  /** role by `${projectId}:${userId}` */
  private readonly roles = new Map<string, number>();
  private readonly guestViewProjects = new Set<string>();
  private failure: AppError | undefined;

  setRole(projectId: string, userId: string, role: number) {
    this.roles.set(`${projectId}:${userId}`, role);
  }

  removeRole(projectId: string, userId: string) {
    this.roles.delete(`${projectId}:${userId}`);
  }

  allowGuestView(projectId: string) {
    this.guestViewProjects.add(projectId);
  }

  failRequestsWith(statusCode: number | undefined) {
    this.failure = statusCode ? new AppError("API failure", { statusCode }) : undefined;
  }

  pageRequests() {
    return this.requests.filter(({ url }) => url.includes("/pages/"));
  }

  get = (url: string, config: { headers?: Record<string, string>; params?: Record<string, unknown> } = {}) => {
    this.requests.push({ url, params: config.params });
    if (this.failure) return Promise.reject(this.failure);

    const userId = config.headers?.Cookie?.replace("session=", "");
    if (url === "/api/users/me/") {
      return Promise.resolve({ data: { id: userId, display_name: userId } });
    }

    const match = url.match(/^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/(.+?)\/$/);
    if (!match || match[1] !== WORKSPACE_SLUG) return this.reject(404);
    const [, , projectId, resource] = match;
    const role = this.roles.get(`${projectId}:${userId}`);

    if (resource === "project-members/me") {
      return role ? Promise.resolve({ data: { role } }) : this.reject(404);
    }

    const page = this.pages.get(resource.replace("pages/", ""));
    if (!role || !page || page.projectId !== projectId) return this.reject(403);
    if (page.ownedBy !== userId) {
      if (role === ROLE.GUEST && !this.guestViewProjects.has(projectId)) return this.reject(403);
      if (page.isPrivate) return this.reject(403);
    }
    return Promise.resolve({
      data: {
        id: page.id,
        owned_by: page.ownedBy,
        is_locked: page.isLocked ?? false,
        archived_at: page.archivedAt ?? null,
      },
    });
  };

  private reject(statusCode: number) {
    return Promise.reject(new AppError("Request refused", { statusCode }));
  }
}
