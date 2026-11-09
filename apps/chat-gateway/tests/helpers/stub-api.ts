/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Fresh for each test file (vitest loads modules per file), so parallel files sharing one Redis never share a channel.
export const WORKSPACE_ID = randomUUID();
export const WORKSPACE_SLUG = "acme";

/** Three members of the workspace, and someone who is signed in but not in it. */
export const ADA = { id: "11111111-1111-4111-8111-111111111111", cookie: "session-id=user-session" };
export const BEN = { id: "33333333-3333-4333-8333-333333333333", cookie: "session-id=ben-session" };
export const CARA = { id: "55555555-5555-4555-8555-555555555555", cookie: "session-id=cara-session" };
export const OUTSIDER = { id: "44444444-4444-4444-8444-444444444444", cookie: "session-id=outsider-session" };

/** The default signed-in user, as in the admission tests. */
export const USER_ID = ADA.id;
export const USER_COOKIE = ADA.cookie;
export const OUTSIDER_COOKIE = OUTSIDER.cookie;
export const OTHER_USER_ID = OUTSIDER.id;

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly cookie: string | undefined;
}

export interface StubChannel {
  readonly id: string;
  readonly kind: "public" | "private" | "dm";
  archived: boolean;
  readonly members: Set<string>;
}

/**
 * Stands in for the Plane API, answering as Django does:
 *
 * - `/api/users/me/` by session cookie;
 * - `/api/workspaces/<slug>/chat/me/` for active members only (a 403 for anyone else, like every chat route);
 * - `/api/workspaces/<slug>/chat/channels/` and `.../<id>/`: a channel is visible to its members and, if it is
 *   public, to every workspace member who is not a guest. A channel the caller can't see is a 404, never a 403.
 */
export class StubPlaneApi {
  /** Session cookie → user ID. */
  readonly users = new Map([
    [ADA.cookie, ADA.id],
    [BEN.cookie, BEN.id],
    [CARA.cookie, CARA.id],
    [OUTSIDER.cookie, OUTSIDER.id],
  ]);
  /** Active members of `WORKSPACE_SLUG`. */
  readonly members = new Set([ADA.id, BEN.id, CARA.id]);
  /** Workspace members who are guests: they see only the channels they are in. */
  readonly guests = new Set<string>();
  readonly channels = new Map<string, StubChannel>();
  /** Every request received, in order, recorded when it arrives. */
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
  /** Hold back answers to paths starting with a key by that many ms. */
  readonly delayPaths = new Map<string, number>();
  /** Answer requests to paths starting with a key with that status. */
  readonly failPaths = new Map<string, number>();
  /** Requests being answered right now, and the most there have been at once. */
  inFlight = 0;
  peakInFlight = 0;
  #server: Server | undefined;

  get url(): string {
    const address = this.#server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => {
      this.arrivedRequests += 1;
      this.inFlight += 1;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      res.once("close", () => {
        this.inFlight -= 1;
        if (!res.writableFinished) this.abortedRequests += 1;
      });
      const url = new URL(req.url ?? "/", "http://api");
      this.requests.push({
        method: req.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        cookie: req.headers.cookie,
      });
      void (async () => {
        const delay = Math.max(
          this.delayMs,
          ...[...this.delayPaths].filter(([prefix]) => url.pathname.startsWith(prefix)).map(([, ms]) => ms)
        );
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const { status, body } = this.#handle(req, url);
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

  /** Add a channel; returns its ID. */
  addChannel(options: { kind?: StubChannel["kind"]; members?: readonly string[]; archived?: boolean } = {}): string {
    const id = randomUUID();
    this.channels.set(id, {
      id,
      kind: options.kind ?? "public",
      archived: options.archived ?? false,
      members: new Set(options.members ?? []),
    });
    return id;
  }

  /** Whether the user can see the channel, as `visible_channels` decides it. */
  canSee(userId: string, channel: StubChannel): boolean {
    if (!this.members.has(userId)) return false;
    return channel.members.has(userId) || (channel.kind === "public" && !this.guests.has(userId));
  }

  #handle(req: IncomingMessage, url: URL): { status: number; body: unknown } {
    if (this.failWith) return { status: this.failWith, body: {} };
    const failure = [...this.failPaths].find(([prefix]) => url.pathname.startsWith(prefix));
    if (failure) return { status: failure[1], body: {} };
    const userId = this.users.get(String(req.headers.cookie ?? ""));
    if (!userId) {
      return { status: this.unauthenticatedStatus, body: { detail: "Authentication credentials were not provided." } };
    }
    if (req.method !== "GET") return { status: 405, body: {} };
    if (url.pathname === "/api/users/me/") return { status: 200, body: { id: userId, display_name: "Ada" } };

    const match = /^\/api\/workspaces\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match) return { status: 404, body: {} };
    const [, slug, rest] = match;
    // The chat routes' permission class answers anyone who isn't an active member with a 403.
    if (slug !== WORKSPACE_SLUG || !this.members.has(userId)) return { status: 403, body: {} };
    if (rest === "chat/me/") {
      return {
        status: 200,
        body: { workspace_id: WORKSPACE_ID, workspace_role: 15, is_workspace_admin: false, can_create_channels: true },
      };
    }

    if (rest === "chat/channels/") {
      const archived = url.searchParams.get("archived") === "true";
      const visible = [...this.channels.values()].filter(
        (channel) => channel.archived === archived && this.canSee(userId, channel)
      );
      return { status: 200, body: visible.map((channel) => this.#payload(userId, channel)) };
    }
    const one = /^chat\/channels\/([^/]+)\/$/.exec(rest);
    if (one) {
      const channel = this.channels.get(one[1]!);
      if (!channel || !this.canSee(userId, channel)) return { status: 404, body: { error: "Channel not found." } };
      return { status: 200, body: this.#payload(userId, channel) };
    }
    return { status: 404, body: {} };
  }

  #payload(userId: string, channel: StubChannel) {
    return {
      id: channel.id,
      workspace: WORKSPACE_ID,
      kind: channel.kind,
      archived_at: channel.archived ? "2026-01-01T00:00:00Z" : null,
      is_member: channel.members.has(userId),
    };
  }
}
