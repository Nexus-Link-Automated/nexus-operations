/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Hocuspocus } from "@hocuspocus/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { TitleSyncExtension } from "@/extensions/title-sync";

const PAGE = "page-1";

// Only the API boundary is replaced. A title save waits on `gate`, so a test can hold an unload open.
const api = vi.hoisted(() => ({ saves: [] as string[], gate: Promise.resolve() }));
vi.mock("@/services/page/handler", () => ({
  getPageService: () => ({
    fetchDetails: () => Promise.resolve({ name: "Plan" }),
    updatePageProperties: async (_id: string, { data }: { data: { name: string } }) => {
      await api.gate;
      api.saves.push(data.name);
    },
  }),
}));
vi.mock("@/env", () => ({ env: { API_BASE_URL: "http://api.test" } }));

describe("TitleSyncExtension across a quick reconnect", () => {
  let server: Hocuspocus;
  let socketServer: WebSocketServer;
  let url: string;
  const providers: HocuspocusProvider[] = [];

  const connect = () => {
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({ url, name: PAGE, document, token: "token" });
    providers.push(provider);
    return { document, provider };
  };

  const rename = (document: Y.Doc, suffix: string) => {
    const text = (document.getXmlFragment("title").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.insert(text.length, suffix);
  };

  const serverTitle = () => server.documents.get(PAGE)?.getXmlFragment("title").toString() ?? "";

  beforeEach(async () => {
    api.saves.length = 0;
    api.gate = Promise.resolve();
    server = new Hocuspocus({
      quiet: true,
      debounce: 10,
      onAuthenticate: () => Promise.resolve({ documentType: "project_page", userId: "u", workspaceSlug: "w" }),
      extensions: [new TitleSyncExtension()],
    });
    socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    socketServer.on("connection", (ws, request) => server.handleConnection(ws, request));
    await once(socketServer, "listening");
    url = `ws://127.0.0.1:${(socketServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    for (const client of socketServer.clients) client.terminate();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  });

  it("keeps saving renames when a client reconnects while the page is unloading", async () => {
    let releaseSave!: () => void;
    api.gate = new Promise<void>((resolve) => (releaseSave = resolve));

    const first = connect();
    await vi.waitFor(() => expect(first.provider.isSynced).toBe(true));
    rename(first.document, " v1");
    await vi.waitFor(() => expect(serverTitle()).toContain("Plan v1"));

    // The last client leaves, so the server starts unloading and saves the title on the way out.
    first.provider.destroy();
    await vi.waitFor(() => expect(server.unloadingDocuments.has(PAGE)).toBe(true));

    // A client comes back before that save finishes, so the unload is abandoned.
    const second = connect();
    await vi.waitFor(() => expect(second.provider.isSynced).toBe(true));
    releaseSave();
    await vi.waitFor(() => expect(server.unloadingDocuments.has(PAGE)).toBe(false));
    expect(server.documents.has(PAGE)).toBe(true);
    expect(api.saves).toEqual(["Plan v1"]);

    rename(second.document, " v2");
    await vi.waitFor(() => expect(serverTitle()).toContain("Plan v1 v2"));
    second.provider.destroy();
    await vi.waitFor(() => expect(server.documents.has(PAGE)).toBe(false));

    expect(api.saves).toEqual(["Plan v1", "Plan v1 v2"]);
  });
});
