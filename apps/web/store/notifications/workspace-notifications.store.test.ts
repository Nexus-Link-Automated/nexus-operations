/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import type { INotification } from "@/store/notifications/notification";
import type { CoreRootStore } from "@/store/root.store";
import { WorkspaceNotificationStore } from "./workspace-notifications.store";

const WORKSPACE_ID = "ws-1";
const hour = 60 * 60 * 1000;
const past = new Date(Date.now() - hour).toISOString();
const future = new Date(Date.now() + hour).toISOString();

const notification = (id: string, fields: Partial<INotification> = {}, minutesAgo = 0) =>
  ({
    id,
    workspace: WORKSPACE_ID,
    is_mentioned_notification: false,
    created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    snoozed_till: undefined,
    archived_at: undefined,
    ...fields,
  }) as unknown as INotification;

const buildStore = (filters: { snoozed?: boolean; archived?: boolean } = {}) => {
  const store = new WorkspaceNotificationStore({ router: {} } as unknown as CoreRootStore);
  store.notifications = {
    plain: notification("plain", {}, 1),
    snoozedPast: notification("snoozedPast", { snoozed_till: past }, 2),
    snoozedFuture: notification("snoozedFuture", { snoozed_till: future }, 3),
    archived: notification("archived", { archived_at: past }, 4),
  };
  store.updateBulkFilters(filters);
  return store;
};

describe("notificationIdsByWorkspaceId snooze handling", () => {
  it("returns a notification to the inbox once its snooze time has passed", () => {
    expect(buildStore().notificationIdsByWorkspaceId(WORKSPACE_ID)).toEqual(["plain", "snoozedPast"]);
  });

  it("lists only notifications whose snooze is still running as snoozed", () => {
    expect(buildStore({ snoozed: true }).notificationIdsByWorkspaceId(WORKSPACE_ID)).toEqual(["snoozedFuture"]);
  });
});
