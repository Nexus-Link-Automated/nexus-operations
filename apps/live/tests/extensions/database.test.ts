/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Hocuspocus, onChangePayload } from "@hocuspocus/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BroadcastedEvent } from "@plane/editor";
import { Database } from "@/extensions/database";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  updateDescriptionBinary: vi.fn(),
  broadcasts: [] as { pageId: string; event: unknown }[],
}));
vi.mock("@/services/page/handler", () => ({
  getPageService: () => ({ updateDescriptionBinary: mocks.updateDescriptionBinary }),
}));
vi.mock("@/utils/broadcast-message", () => ({
  broadcastMessageToPage: (_instance: Hocuspocus, pageId: string, event: unknown) => {
    mocks.broadcasts.push({ pageId, event });
    return Promise.resolve(true);
  },
}));
vi.mock("@/env", () => ({ env: { API_BASE_URL: "http://api.test" } }));

const context = { documentType: "project_page", userId: "user-1", workspaceSlug: "acme" };

const store = (database: Database, documentName: string) =>
  database.onStoreDocument({
    context,
    document: new Y.Doc(),
    documentName,
    instance: {} as Hocuspocus,
  } as unknown as onChangePayload);

const actions = (pageId: string) =>
  mocks.broadcasts
    .filter((broadcast) => broadcast.pageId === pageId)
    .map(({ event }) => {
      const { action, data } = event as BroadcastedEvent;
      return action === "error" ? `error:${(data as { error_type: string }).error_type}` : action;
    });

describe("Database store", () => {
  beforeEach(() => {
    mocks.broadcasts.length = 0;
    mocks.updateDescriptionBinary.mockReset();
  });

  it("reports a failed save, then announces the next successful save once", async () => {
    const database = new Database();
    mocks.updateDescriptionBinary.mockRejectedValueOnce(new AppError("API failure", { statusCode: 503 }));
    await expect(store(database, "page-failing")).rejects.toThrow();
    expect(actions("page-failing")).toEqual(["error:store"]);

    mocks.updateDescriptionBinary.mockResolvedValue(undefined);
    await store(database, "page-failing");
    expect(actions("page-failing")).toEqual(["error:store", "saved"]);

    await store(database, "page-failing");
    expect(actions("page-failing")).toEqual(["error:store", "saved"]);
  });

  it("sends nothing when a save succeeds and no earlier save failed", async () => {
    mocks.updateDescriptionBinary.mockResolvedValue(undefined);
    await store(new Database(), "page-healthy");
    expect(actions("page-healthy")).toEqual([]);
  });
});
