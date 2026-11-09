/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { AUTHENTICATION_DEADLINE_MS, guardCollaborationSocket } from "@/lib/collaboration-socket-guard";
import { onAuthenticate } from "@/lib/auth";
import { APIService } from "@/services/api.service";
import type { HocusPocusServerContext } from "@/types";
import {
  FakePageApi,
  OTHER_PROJECT_ID,
  PAGE_ID,
  PROJECT_ID,
  ROLE,
  WORKSPACE_SLUG,
  tokenFor,
} from "../helpers/fake-page-api";

vi.mock("@/env", () => ({ env: { API_BASE_URL: "http://api.test" } }));

const OWNER = "owner";
const OWNER_GUEST = "owner-guest";
const ADMIN = "admin";
const MEMBER = "member";
const GUEST = "guest";
const OUTSIDER = "outsider";

const authenticate = async ({
  userId = MEMBER,
  documentName = PAGE_ID,
  documentType = "project_page",
  workspaceSlug = WORKSPACE_SLUG,
  projectId = PROJECT_ID,
  request = {} as IncomingMessage,
}: {
  userId?: string;
  documentName?: string;
  documentType?: string;
  workspaceSlug?: string;
  projectId?: string;
  request?: IncomingMessage;
} = {}) => {
  const connectionConfig = { readOnly: false, isAuthenticated: false };
  const context = {} as HocusPocusServerContext;
  const result = await onAuthenticate({
    requestHeaders: {},
    requestParameters: new URLSearchParams({ documentType, workspaceSlug, projectId }),
    context,
    token: tokenFor(userId),
    documentName,
    connectionConfig,
    request,
  });
  return { result, connectionConfig, context };
};

describe("onAuthenticate document access", () => {
  let api: FakePageApi;

  beforeEach(() => {
    api = new FakePageApi();
    api.pages.set(PAGE_ID, { id: PAGE_ID, projectId: PROJECT_ID, ownedBy: OWNER });
    api.setRole(PROJECT_ID, OWNER, ROLE.MEMBER);
    api.setRole(PROJECT_ID, OWNER_GUEST, ROLE.GUEST);
    api.setRole(PROJECT_ID, ADMIN, ROLE.ADMIN);
    api.setRole(PROJECT_ID, MEMBER, ROLE.MEMBER);
    api.setRole(PROJECT_ID, GUEST, ROLE.GUEST);
    api.allowGuestView(PROJECT_ID);
    vi.spyOn(APIService.prototype, "get").mockImplementation(api.get as unknown as APIService["get"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "an admin on a public page", userId: ADMIN, page: {}, readOnly: false },
    { name: "a member on a public page", userId: MEMBER, page: {}, readOnly: false },
    { name: "the owner of a private page", userId: OWNER, page: { isPrivate: true }, readOnly: false },
    { name: "an owner with the guest role", userId: OWNER_GUEST, page: { ownedBy: OWNER_GUEST }, readOnly: false },
    { name: "a guest allowed to view the project", userId: GUEST, page: {}, readOnly: true },
    { name: "a member on a locked page", userId: MEMBER, page: { isLocked: true }, readOnly: true },
    { name: "the owner of a locked page", userId: OWNER, page: { isLocked: true }, readOnly: true },
    { name: "an admin on an archived page", userId: ADMIN, page: { archivedAt: "2026-01-01" }, readOnly: true },
    { name: "the owner of an archived page", userId: OWNER, page: { archivedAt: "2026-01-01" }, readOnly: true },
  ])("gives $name a connection with readOnly=$readOnly", async ({ userId, page, readOnly }) => {
    api.pages.set(PAGE_ID, { ...api.pages.get(PAGE_ID)!, ...page });

    const { connectionConfig, result } = await authenticate({ userId });

    expect(connectionConfig.readOnly).toBe(readOnly);
    expect(result).toEqual({ user: { id: userId, name: userId } });
  });

  it.each([
    {
      name: "a user who is not in the project",
      setup: () => {},
      params: { userId: OUTSIDER },
    },
    {
      name: "a non-owner of a private page",
      setup: () => api.pages.set(PAGE_ID, { id: PAGE_ID, projectId: PROJECT_ID, ownedBy: OWNER, isPrivate: true }),
      params: {},
    },
    {
      name: "a guest when the project does not allow guests to view pages",
      setup: () => {
        api = new FakePageApi();
        api.pages.set(PAGE_ID, { id: PAGE_ID, projectId: PROJECT_ID, ownedBy: OWNER });
        api.setRole(PROJECT_ID, GUEST, ROLE.GUEST);
        vi.spyOn(APIService.prototype, "get").mockImplementation(api.get as unknown as APIService["get"]);
      },
      params: { userId: GUEST },
    },
    {
      name: "a project the page does not belong to, even for a member of it",
      setup: () => api.setRole(OTHER_PROJECT_ID, MEMBER, ROLE.ADMIN),
      params: { projectId: OTHER_PROJECT_ID },
    },
    {
      name: "a workspace the page does not belong to",
      setup: () => {},
      params: { workspaceSlug: "other-workspace" },
    },
    {
      name: "a page that no longer exists",
      setup: () => api.pages.delete(PAGE_ID),
      params: {},
    },
    {
      name: "a document type the server does not support",
      setup: () => {},
      params: { documentType: "unknown_page" },
    },
  ])("refuses $name", async ({ setup, params }) => {
    setup();
    await expect(authenticate(params)).rejects.toThrow();
  });

  it("refuses when the project role cannot be read", async () => {
    vi.spyOn(APIService.prototype, "get").mockImplementation(((url: string, config: unknown) =>
      url.endsWith("project-members/me/")
        ? Promise.reject(new Error("unavailable"))
        : api.get(url, config as never)) as unknown as APIService["get"]);

    await expect(authenticate()).rejects.toThrow();
  });

  it("refuses when the API answers for a different page", async () => {
    vi.spyOn(APIService.prototype, "get").mockImplementation((async (url: string, config: unknown) => {
      const response = await api.get(url, config as never);
      return url.includes("/pages/") ? { data: { ...response.data, id: OTHER_PROJECT_ID } } : response;
    }) as unknown as APIService["get"]);

    await expect(authenticate()).rejects.toThrow();
  });

  it.each([
    { name: "a document name that is not a page id", params: { documentName: "../../../users/me" } },
    { name: "an upper-case page id", params: { documentName: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() } },
    { name: "a project id with path segments", params: { projectId: "../../other" } },
    { name: "a workspace slug with path segments", params: { workspaceSlug: "acme/../other" } },
    { name: "a workspace slug of dots", params: { workspaceSlug: ".." } },
  ])("refuses $name without calling the page API", async ({ params }) => {
    await expect(authenticate(params)).rejects.toThrow();
    expect(api.pageRequests()).toEqual([]);
  });

  it("does not record a page visit for the check", async () => {
    await authenticate();
    const details = api.requests.find(({ url }) => url.endsWith(`/pages/${PAGE_ID}/`));
    expect(details?.params).toEqual({ track_visit: false });
  });

  it("does not ask about the page when the credentials do not match the user", async () => {
    vi.spyOn(APIService.prototype, "get").mockImplementation(((url: string, config: unknown) =>
      url === "/api/users/me/"
        ? Promise.resolve({ data: { id: "someone-else" } })
        : api.get(url, config as never)) as unknown as APIService["get"]);

    await expect(authenticate()).rejects.toThrow();
    expect(api.pageRequests()).toEqual([]);
  });

  describe("authentication deadline", () => {
    const guardedRequest = () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const socket = Object.assign(new EventEmitter(), { close: vi.fn(), terminate: vi.fn() });
      const request = {} as IncomingMessage;
      guardCollaborationSocket(socket as unknown as WebSocket, request);
      return { socket, request };
    };

    it("is cleared once the document access check passes", async () => {
      const { socket, request } = guardedRequest();

      await authenticate({ request });
      vi.advanceTimersByTime(AUTHENTICATION_DEADLINE_MS);

      expect(socket.close).not.toHaveBeenCalled();
    });

    it("still applies when the document access check fails", async () => {
      const { socket, request } = guardedRequest();

      await expect(authenticate({ userId: OUTSIDER, request })).rejects.toThrow();
      vi.advanceTimersByTime(AUTHENTICATION_DEADLINE_MS);

      expect(socket.close).toHaveBeenCalledOnce();
    });
  });
});
