/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
export const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const WORKSPACE_SLUG = "acme";
/** A signed-in member of the workspace. */
export const USER_COOKIE = "session-id=user-session";
/** Signed in, but not a member of the workspace. */
export const OUTSIDER_COOKIE = "session-id=outsider-session";

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly cookie: string | undefined;
}

/**
 * Stands in for the Plane API, answering as Django does: `/api/users/me/` by session cookie, and
 * `/api/workspaces/<slug>/` for active members only (a 404 for anyone else).
 */
export class StubPlaneApi {
  /** Session cookie → user ID. */
  readonly users = new Map([
    [USER_COOKIE, USER_ID],
    [OUTSIDER_COOKIE, OTHER_USER_ID],
  ]);
  /** Active members of `WORKSPACE_SLUG`. */
  readonly members = new Set([USER_ID]);
  /** Every request received, in order. */
  readonly requests: StubRequest[] = [];
  /** What Django answers an unknown cookie with (401; the gateway treats a 403 the same way). */
  unauthenticatedStatus = 401;
  /** Answer every request with this status instead (e.g. 500). */
  failWith: number | undefined;
  /** Hold every answer back this long. */
  delayMs = 0;
  /** Requests that have reached the stub, including those still being held back. */
  arrivedRequests = 0;
  /** Requests whose caller hung up before the answer. */
  abortedRequests = 0;
  #server: Server | undefined;

  get url(): string {
    const address = this.#server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      this.arrivedRequests += 1;
      res.once("close", () => {
        if (!res.writableFinished) this.abortedRequests += 1;
      });
      void (async () => {
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        const { status, body } = this.handle(req);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      })();
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server?.closeAllConnections();
      this.#server?.close(() => resolve());
    });
  }

  /** Requests to `path` (a prefix), so tests can tell which calls the gateway made. */
  requestsTo(path: string): StubRequest[] {
    return this.requests.filter((request) => request.path.startsWith(path));
  }

  /** Overridden by subclasses to add routes; this answers the routes every gateway needs. */
  protected handle(req: IncomingMessage): { status: number; body: unknown } {
    const url = new URL(req.url ?? "/", "http://api");
    const cookie = req.headers.cookie;
    this.requests.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}`, cookie });
    if (this.failWith) return { status: this.failWith, body: {} };

    const userId = this.users.get(String(cookie ?? ""));
    if (!userId) {
      return { status: this.unauthenticatedStatus, body: { detail: "Authentication credentials were not provided." } };
    }
    if (req.method === "GET" && url.pathname === "/api/users/me/") {
      return { status: 200, body: { id: userId, display_name: "Ada" } };
    }
    const workspace = /^\/api\/workspaces\/([^/]+)\/$/.exec(url.pathname);
    if (req.method === "GET" && workspace) {
      if (workspace[1] !== WORKSPACE_SLUG || !this.members.has(userId)) {
        return { status: 404, body: { error: "Workspace not found" } };
      }
      return { status: 200, body: { id: WORKSPACE_ID, slug: WORKSPACE_SLUG, name: "Acme" } };
    }
    return { status: 404, body: {} };
  }
}
