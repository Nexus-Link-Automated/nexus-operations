/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EventEmitter } from "node:events";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { describe, expect, it, vi } from "vitest";
import { createRealtimeEvent } from "@/types/document-collaborative-events";
import { parsePageEvent, routePageEvents } from "../realtime-page-events";

const saveError = createRealtimeEvent({
  action: "error",
  page_id: "page-1",
  descendants_ids: [],
  data: { error_message: "Unable to save the page. Please try again.", error_type: "store", user_id: "u" },
  workspace_slug: "acme",
  user_id: "u",
});

describe("parsePageEvent", () => {
  it("reads a page event broadcast by the live server", () => {
    expect(parsePageEvent(JSON.stringify(saveError))).toEqual({
      pageIds: ["page-1"],
      action: "error",
      data: saveError.data,
    });
  });

  it("includes descendant pages", () => {
    const event = createRealtimeEvent({
      action: "saved",
      page_id: "page-1",
      descendants_ids: ["page-2", ""],
      data: {},
      workspace_slug: "acme",
      user_id: "u",
    });
    expect(parsePageEvent(JSON.stringify(event))?.pageIds).toEqual(["page-1", "page-2"]);
  });

  it.each([
    ["a plain action name", "locked"],
    ["a force-close notice", JSON.stringify({ type: "force_close", code: 4001 })],
    ["an unknown action", JSON.stringify({ ...saveError, action: "something_else" })],
    ["an event without pages", JSON.stringify({ ...saveError, affectedPages: { currentPage: "" } })],
    ["an event without data", JSON.stringify({ ...saveError, data: null })],
    ["a JSON scalar", "1"],
  ])("ignores %s", (_label, payload) => {
    expect(parsePageEvent(payload)).toBeUndefined();
  });
});

describe("routePageEvents", () => {
  it("passes broadcast page events to updatePageProperties until unsubscribed", () => {
    const provider = new EventEmitter();
    const updatePageProperties = vi.fn();
    const stop = routePageEvents(provider as unknown as HocuspocusProvider, updatePageProperties);

    provider.emit("stateless", { payload: "locked" });
    provider.emit("stateless", { payload: JSON.stringify(saveError) });
    expect(updatePageProperties).toHaveBeenCalledTimes(1);
    expect(updatePageProperties).toHaveBeenCalledWith(["page-1"], "error", saveError.data);

    stop();
    provider.emit("stateless", { payload: JSON.stringify(saveError) });
    expect(updatePageProperties).toHaveBeenCalledTimes(1);
  });
});
