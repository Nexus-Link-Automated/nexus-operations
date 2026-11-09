/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { EventBus } from "./bus.ts";
import { parseEvent, type ChatEvent } from "./events.ts";
import type { Logger } from "./logger.ts";

/** How long a first socket waits for Redis to confirm its workspace's subscription. */
const SUBSCRIBE_TIMEOUT_MS = 5_000;

/** A socket the hub hands events to. */
export interface Recipient {
  readonly workspaceId: string;
  /** An event in this recipient's workspace. The recipient decides whether its user may see it. */
  deliver(event: ChatEvent): void;
  /** Events may have been missed. */
  resync(reason: "events_missed"): void;
}

interface Room {
  readonly recipients: Set<Recipient>;
  /** Settles once the bus is listening to the workspace. */
  readonly listening: Promise<void>;
}

/**
 * Fans the bus's events out to the sockets of the workspace they belong to. A workspace is subscribed on the
 * bus while at least one socket is in it. The hub decides nothing about who may see an event: it hands every
 * event to every socket in its workspace, and each socket checks against what the API said about its user.
 */
export class Hub {
  readonly #bus: EventBus;
  readonly #log: Logger;
  readonly #rooms = new Map<string, Room>();

  constructor(options: { readonly bus: EventBus; readonly log: Logger }) {
    this.#bus = options.bus;
    this.#log = options.log;
    this.#bus.onMessage((workspaceId, raw) => this.#dispatch(workspaceId, raw));
    this.#bus.onGap(() => this.#gap());
  }

  /** Workspaces with at least one socket in them. */
  get workspaceCount(): number {
    return this.#rooms.size;
  }

  /**
   * Put a recipient in its workspace's room, subscribing the bus if it is the first. Resolves once events
   * for the workspace are flowing, so anything that happens afterwards reaches the recipient.
   */
  async join(recipient: Recipient): Promise<void> {
    let room = this.#rooms.get(recipient.workspaceId);
    if (!room) {
      room = { recipients: new Set(), listening: this.#listen(recipient.workspaceId) };
      this.#rooms.set(recipient.workspaceId, room);
    }
    room.recipients.add(recipient);
    try {
      await room.listening;
    } catch (error) {
      this.leave(recipient);
      throw error;
    }
  }

  /** Take a recipient out of its room, unsubscribing the bus if it was the last. Safe to call twice. */
  leave(recipient: Recipient): void {
    const room = this.#rooms.get(recipient.workspaceId);
    if (!room?.recipients.delete(recipient) || room.recipients.size > 0) return;
    this.#rooms.delete(recipient.workspaceId);
    this.#bus.unsubscribe(recipient.workspaceId).catch((error: unknown) => {
      this.#log.warn("chat-gateway: could not unsubscribe from the event bus", { error: (error as Error).message });
    });
  }

  async #listen(workspaceId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out subscribing to the event bus")), SUBSCRIBE_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.#bus.subscribe(workspaceId), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  #dispatch(workspaceId: string, raw: string): void {
    const room = this.#rooms.get(workspaceId);
    if (!room) return;
    const event = parseEvent(raw);
    if (!event) {
      this.#log.debug("chat-gateway: ignored an event it doesn't understand", { workspaceId });
      return;
    }
    // An event is only ever for the workspace whose channel it came on.
    if (event.workspace_id !== workspaceId) {
      this.#log.warn("chat-gateway: ignored an event published to the wrong workspace", { workspaceId });
      return;
    }
    for (const recipient of room.recipients) {
      try {
        recipient.deliver(event);
      } catch (error) {
        this.#log.error("chat-gateway: could not deliver an event", { error: (error as Error).message });
      }
    }
  }

  #gap(): void {
    this.#log.warn("chat-gateway: events may have been missed; telling every socket to resync");
    for (const room of this.#rooms.values()) {
      for (const recipient of room.recipients) recipient.resync("events_missed");
    }
  }
}
