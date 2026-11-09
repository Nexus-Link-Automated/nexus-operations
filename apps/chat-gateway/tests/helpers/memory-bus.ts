/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { EventBus } from "../../src/bus.ts";

/** An in-process `EventBus` that behaves like Redis pub/sub: only subscribed workspaces' events are delivered. */
export class MemoryEventBus implements EventBus {
  connected = true;
  /** Workspaces currently subscribed. */
  readonly subscribed = new Set<string>();
  /** Every subscribe / unsubscribe call, in order. */
  readonly calls: string[] = [];
  #messageHandlers: ((workspaceId: string, raw: string) => void)[] = [];
  #gapHandlers: (() => void)[] = [];

  async subscribe(workspaceId: string): Promise<void> {
    this.calls.push(`subscribe ${workspaceId}`);
    if (!this.connected) throw new Error("not connected");
    this.subscribed.add(workspaceId);
  }

  async unsubscribe(workspaceId: string): Promise<void> {
    this.calls.push(`unsubscribe ${workspaceId}`);
    this.subscribed.delete(workspaceId);
  }

  onMessage(handler: (workspaceId: string, raw: string) => void): void {
    this.#messageHandlers.push(handler);
  }

  onGap(handler: () => void): void {
    this.#gapHandlers.push(handler);
  }

  async close(): Promise<void> {}

  /** What Django's publish does: reaches whoever is listening to the workspace. */
  publish(workspaceId: string, payload: string): void {
    if (!this.subscribed.has(workspaceId)) return;
    for (const handler of this.#messageHandlers) handler(workspaceId, payload);
  }

  /** The Redis connection dropped and came back. */
  triggerGap(): void {
    for (const handler of this.#gapHandlers) handler();
  }
}
