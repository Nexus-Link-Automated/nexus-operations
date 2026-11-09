/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Document, Hocuspocus } from "@hocuspocus/server";
import { getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TITLE_EDITOR_EXTENSIONS, generateTitleProsemirrorJson } from "@plane/editor/server";
import { TitleSyncExtension } from "@/extensions/title-sync";
import type { HocusPocusServerContext } from "@/types";

const mocks = vi.hoisted(() => ({ scheduleUpdate: vi.fn() }));

vi.mock("@/extensions/title-update/title-update-manager", () => ({
  TitleUpdateManager: class {
    scheduleUpdate = mocks.scheduleUpdate;
  },
}));
vi.mock("@/services/page/handler", () => ({ getPageService: vi.fn() }));
vi.mock("@/env", () => ({ env: { API_BASE_URL: "http://api.test" } }));

const context = { userId: "user-1", workspaceSlug: "acme" } as HocusPocusServerContext;

/** The Yjs update the title editor produces for a heading holding `text`. */
const titleUpdate = (text: string) =>
  Y.encodeStateAsUpdate(
    prosemirrorJSONToYDoc(getSchema(TITLE_EDITOR_EXTENSIONS), generateTitleProsemirrorJson(text), "title")
  );

describe("TitleSyncExtension", () => {
  beforeEach(() => {
    mocks.scheduleUpdate.mockClear();
  });

  it.each(["R&D plan", "Use Array<T> in types", "a < b && c > d", "<b>Bold</b> move", "  Q&A  "])(
    "saves %j as the literal text of the title",
    async (title) => {
      const document = new Y.Doc();
      await new TitleSyncExtension().afterLoadDocument({
        document: document as unknown as Document,
        documentName: "page-1",
        context,
        instance: {} as Hocuspocus,
      });

      Y.applyUpdate(document, titleUpdate(title));

      expect(mocks.scheduleUpdate).toHaveBeenLastCalledWith(title.trim());
    }
  );
});
