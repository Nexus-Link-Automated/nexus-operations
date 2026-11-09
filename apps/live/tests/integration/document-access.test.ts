/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IncomingMessage, MessageType, OutgoingMessage } from "@hocuspocus/server";
import type { Connection, Hocuspocus } from "@hocuspocus/server";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { CollaborationController } from "@/controllers/collaboration.controller";
import { HocusPocusServerManager } from "@/hocuspocus";
import { MAX_PENDING_MESSAGES } from "@/lib/collaboration-socket-guard";
import { APIService } from "@/services/api.service";
import { FakePageApi, PAGE_ID, PROJECT_ID, ROLE, WORKSPACE_SLUG, tokenFor } from "../helpers/fake-page-api";

vi.mock("@/env", () => ({ env: { API_BASE_URL: "http://api.test", HOSTNAME: "test-server" } }));
vi.mock("@/extensions", () => ({ getExtensions: () => [] }));

const OWNER = "owner";
const MEMBER = "member";
const OTHER_MEMBER = "other-member";
const GUEST = "guest";
const OUTSIDER = "outsider";

const FIELD = "content";

describe("collaboration connections and document access", () => {
  let api: FakePageApi;
  let server: Hocuspocus;
  let socketServer: WebSocketServer;
  let url: string;
  const providers: HocuspocusProvider[] = [];

  const open = (userId: string) => {
    const document = new Y.Doc();
    const denied = vi.fn();
    const closes: number[] = [];
    const provider = new HocuspocusProvider({
      url,
      name: PAGE_ID,
      document,
      token: tokenFor(userId),
      onAuthenticationFailed: denied,
      onClose: ({ event }) => closes.push(event.code),
    });
    providers.push(provider);
    return {
      provider,
      denied,
      closes,
      type: (text: string) => document.getText(FIELD).insert(document.getText(FIELD).length, text),
      text: () => document.getText(FIELD).toString(),
    };
  };

  const openSynced = async (userId: string) => {
    const client = open(userId);
    await vi.waitFor(() => expect(client.provider.synced).toBe(true), { timeout: 5_000 });
    return client;
  };

  const serverText = () => server.documents.get(PAGE_ID)?.getText(FIELD).toString();

  const serverConnection = (userId: string): Connection => {
    const entry = server.documents
      .get(PAGE_ID)!
      .getConnections()
      .find((connection) => (connection.context as { userId: string }).userId === userId);
    return entry!;
  };

  /** Makes the next edit from this user look like it came long after the last access check. */
  const expireAccessCheck = (userId: string) => {
    (serverConnection(userId).context as { accessCheckedAt: number }).accessCheckedAt = 0;
  };

  /** Resolves when the server has refused an edit from this connection. */
  const watchRefusedEdits = (connection: Connection) => {
    const send = vi.spyOn(connection, "send");
    return () =>
      vi.waitFor(
        () => {
          const refused = send.mock.calls.some(([data]) => {
            const message = new IncomingMessage(data as Uint8Array);
            message.readVarString();
            return message.readVarUint() === MessageType.SyncStatus && message.readVarUint() === 0;
          });
          expect(refused).toBe(true);
        },
        { timeout: 5_000 }
      );
  };

  beforeEach(async () => {
    api = new FakePageApi();
    api.pages.set(PAGE_ID, { id: PAGE_ID, projectId: PROJECT_ID, ownedBy: OWNER });
    api.setRole(PROJECT_ID, OWNER, ROLE.GUEST);
    api.setRole(PROJECT_ID, MEMBER, ROLE.MEMBER);
    api.setRole(PROJECT_ID, OTHER_MEMBER, ROLE.MEMBER);
    api.setRole(PROJECT_ID, GUEST, ROLE.GUEST);
    api.allowGuestView(PROJECT_ID);
    vi.spyOn(APIService.prototype, "get").mockImplementation(api.get as unknown as APIService["get"]);

    server = await HocusPocusServerManager.getInstance().initialize();
    server.configuration.quiet = true;
    const controller = new CollaborationController(server);
    socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    socketServer.on("connection", (socket, request) => controller.handleConnection(socket, request as Request));
    await once(socketServer, "listening");
    const { port } = socketServer.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/?documentType=project_page&workspaceSlug=${WORKSPACE_SLUG}&projectId=${PROJECT_ID}`;
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    socketServer.clients.forEach((client) => client.terminate());
    await new Promise((resolve) => socketServer.close(resolve));
    HocusPocusServerManager.resetInstance();
    vi.restoreAllMocks();
  });

  it("does not send an open document to a user without access to it", async () => {
    const editor = await openSynced(MEMBER);
    editor.type("written by a member");
    await vi.waitFor(() => expect(serverText()).toBe("written by a member"));

    const outsider = open(OUTSIDER);

    await vi.waitFor(() => expect(outsider.denied).toHaveBeenCalled(), { timeout: 5_000 });
    expect(outsider.text()).toBe("");
    expect(server.documents.get(PAGE_ID)!.getConnectionsCount()).toBe(1);
  });

  it("keeps a viewer's edits out of the document while editors keep working", async () => {
    const editor = await openSynced(MEMBER);
    const viewer = await openSynced(GUEST);
    const editRefused = watchRefusedEdits(serverConnection(GUEST));

    viewer.type("from a viewer");
    await editRefused();
    editor.type("from an editor");

    await vi.waitFor(() => expect(viewer.text()).toContain("from an editor"));
    expect(serverText()).toBe("from an editor");
    expect(editor.text()).toBe("from an editor");
    expect(viewer.provider.authorizedScope).toBe("readonly");
  });

  it("lets a page owner with the guest role edit", async () => {
    const owner = await openSynced(OWNER);

    owner.type("from the owner");

    await vi.waitFor(() => expect(serverText()).toBe("from the owner"));
  });

  it("checks access again and keeps each user's mode when they reconnect", async () => {
    await openSynced(OTHER_MEMBER);
    const editor = await openSynced(MEMBER);
    const viewer = await openSynced(GUEST);
    const checksBefore = api.pageRequests().length;

    editor.provider.disconnect();
    viewer.provider.disconnect();
    await vi.waitFor(() => expect(server.documents.get(PAGE_ID)!.getConnectionsCount()).toBe(1));
    await Promise.all([editor.provider.connect(), viewer.provider.connect()]);
    await vi.waitFor(
      () => {
        expect(server.documents.get(PAGE_ID)!.getConnectionsCount()).toBe(3);
        expect(editor.provider.synced && viewer.provider.synced).toBe(true);
      },
      { timeout: 5_000 }
    );

    expect(api.pageRequests().length).toBeGreaterThan(checksBefore);
    expect(serverConnection(GUEST).readOnly).toBe(true);
    expect(serverConnection(MEMBER).readOnly).toBe(false);

    const editRefused = watchRefusedEdits(serverConnection(GUEST));
    viewer.type("still only a viewer");
    await editRefused();
    editor.type("after reconnecting");
    await vi.waitFor(() => expect(serverText()).toBe("after reconnecting"));
  });

  it("accepts edits after a page locked at connect time is unlocked", async () => {
    api.pages.get(PAGE_ID)!.isLocked = true;
    const editor = await openSynced(MEMBER);
    expect(serverConnection(MEMBER).readOnly).toBe(true);

    api.pages.get(PAGE_ID)!.isLocked = false;
    expireAccessCheck(MEMBER);
    editor.type("after unlocking");

    await vi.waitFor(() => expect(serverText()).toBe("after unlocking"));
    expect(serverConnection(MEMBER).readOnly).toBe(false);
  });

  it("accepts edits after an archived page is restored", async () => {
    api.pages.get(PAGE_ID)!.archivedAt = "2026-01-01";
    const editor = await openSynced(MEMBER);

    api.pages.get(PAGE_ID)!.archivedAt = null;
    expireAccessCheck(MEMBER);
    editor.type("after restoring");

    await vi.waitFor(() => expect(serverText()).toBe("after restoring"));
  });

  it("recovers edits refused while the page was read-only once it can be edited", async () => {
    api.pages.get(PAGE_ID)!.isLocked = true;
    const editor = await openSynced(MEMBER);
    const editRefused = watchRefusedEdits(serverConnection(MEMBER));
    editor.type("first ");
    await editRefused();
    expect(serverText()).toBe("");

    api.pages.get(PAGE_ID)!.isLocked = false;
    expireAccessCheck(MEMBER);
    editor.type("second");

    await vi.waitFor(() => expect(serverText()).toBe("first second"));
  });

  it("stops accepting edits once a page is locked", async () => {
    const editor = await openSynced(MEMBER);
    editor.type("before locking");
    await vi.waitFor(() => expect(serverText()).toBe("before locking"));

    api.pages.get(PAGE_ID)!.isLocked = true;
    expireAccessCheck(MEMBER);
    const editRefused = watchRefusedEdits(serverConnection(MEMBER));
    editor.type(" after locking");
    await editRefused();

    expect(serverText()).toBe("before locking");
    expect(serverConnection(MEMBER).readOnly).toBe(true);
  });

  it("does not re-check an editor on every edit", async () => {
    const editor = await openSynced(MEMBER);
    const checksBefore = api.pageRequests().length;

    editor.type("one");
    editor.type("two");
    await vi.waitFor(() => expect(serverText()).toBe("onetwo"));

    expect(api.pageRequests().length).toBe(checksBefore);
  });

  it("closes the socket and refuses the edit when an editor has lost access", async () => {
    await openSynced(OTHER_MEMBER);
    const editor = await openSynced(MEMBER);
    editor.type("before removal");
    await vi.waitFor(() => expect(serverText()).toBe("before removal"));

    api.removeRole(PROJECT_ID, MEMBER);
    expireAccessCheck(MEMBER);
    editor.type(" after removal");

    await vi.waitFor(() => expect(editor.denied).toHaveBeenCalled(), { timeout: 5_000 });
    expect(editor.closes).toContain(4403);
    expect(serverText()).toBe("before removal");
  });

  it("applies the queue limits again to a document closed on an open socket", async () => {
    const editor = await openSynced(MEMBER);
    const socket = editor.provider.configuration.websocketProvider.webSocket!;

    socket.send(new OutgoingMessage(PAGE_ID).writeCloseMessage("closed by the client").toUint8Array());
    await vi.waitFor(() => expect(server.documents.has(PAGE_ID)).toBe(false));
    const queued = new OutgoingMessage(PAGE_ID).writeQueryAwareness().toUint8Array();
    for (let index = 0; index <= MAX_PENDING_MESSAGES; index++) socket.send(queued);

    await vi.waitFor(() => expect(socket.readyState).toBe(socket.CLOSED), { timeout: 5_000 });
  });

  it("keeps an editor connected when the API cannot answer the re-check", async () => {
    const editor = await openSynced(MEMBER);

    api.failRequestsWith(503);
    expireAccessCheck(MEMBER);
    editor.type("during an API outage");

    await vi.waitFor(() => expect(serverText()).toBe("during an API outage"));
    expect(serverConnection(MEMBER).readOnly).toBe(false);
    expect(editor.denied).not.toHaveBeenCalled();
  });
});
