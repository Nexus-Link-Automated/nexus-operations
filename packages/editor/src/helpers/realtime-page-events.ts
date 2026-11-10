/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { HocuspocusProvider } from "@hocuspocus/provider";
import { DocumentCollaborativeEvents } from "@/constants/document-collaborative-events";
import type { EventToPayloadMap } from "@/types/document-collaborative-events";
import type { ICollaborativeDocumentEditorProps } from "@/types/editor";

type TPageEventAction = keyof EventToPayloadMap;

export type TParsedPageEvent = {
  pageIds: string[];
  action: TPageEventAction;
  data: EventToPayloadMap[TPageEventAction];
};

const PAGE_EVENT_ACTIONS = new Set<string>(Object.values(DocumentCollaborativeEvents).map((event) => event.client));

/**
 * Reads a page event that the live server broadcasts as a JSON stateless message (see `createRealtimeEvent`).
 * Returns undefined for anything else, such as plain action names and force-close notices.
 */
export const parsePageEvent = (payload: string): TParsedPageEvent | undefined => {
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) return undefined;

  const { action, data, affectedPages } = message as Record<string, unknown>;
  if (typeof action !== "string" || !PAGE_EVENT_ACTIONS.has(action)) return undefined;
  if (typeof data !== "object" || data === null) return undefined;
  if (typeof affectedPages !== "object" || affectedPages === null) return undefined;

  const { currentPage, descendantPages } = affectedPages as Record<string, unknown>;
  const pageIds = [currentPage, ...(Array.isArray(descendantPages) ? descendantPages : [])].filter(
    (id): id is string => typeof id === "string" && id !== ""
  );
  if (pageIds.length === 0) return undefined;

  return { pageIds, action: action as TPageEventAction, data: data as TParsedPageEvent["data"] };
};

/**
 * Passes the page events the live server broadcasts to `updatePageProperties`. Returns the unsubscribe function.
 */
export const routePageEvents = (
  provider: Pick<HocuspocusProvider, "on" | "off">,
  updatePageProperties: NonNullable<ICollaborativeDocumentEditorProps["updatePageProperties"]>
) => {
  const handleStateless = ({ payload }: { payload: string }) => {
    const event = parsePageEvent(payload);
    if (event) updatePageProperties(event.pageIds, event.action, event.data);
  };
  provider.on("stateless", handleStateless);
  return () => {
    provider.off("stateless", handleStateless);
  };
};
