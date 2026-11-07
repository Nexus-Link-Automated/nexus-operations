/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* oxlint-disable no-await-in-loop -- polling */
import { WebSocket } from "ws";

export type Frame = Record<string, unknown> & { type?: string };

/** A browser stand-in: collects every JSON frame the gateway sends, and how the socket ended. */
export class ChatClient {
  readonly frames: Frame[] = [];
  closeCode: number | undefined;
  closeReason = "";
  /** The HTTP status when the upgrade was refused before a socket existed. */
  unexpectedStatus: number | undefined;
  readonly opened: Promise<void>;
  readonly socket: WebSocket;

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on("message", (data) => this.frames.push(JSON.parse(String(data)) as Frame));
    this.socket.on("close", (code, reason) => {
      this.closeCode = code;
      this.closeReason = String(reason);
    });
    this.socket.on("unexpected-response", (_req, res) => {
      this.unexpectedStatus = res.statusCode;
      this.closeCode = -1;
      this.socket.terminate();
    });
    this.socket.on("error", () => undefined);
    this.opened = new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("close", () => reject(new Error("closed before open")));
    });
    this.opened.catch(() => undefined);
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The first frame matching `predicate`, waiting for it if it hasn't arrived. */
  async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    return waitUntil(() => this.frames.find(predicate), timeoutMs);
  }

  /** The first frame of this `type`. */
  async next(type: string, timeoutMs = 5_000): Promise<Frame> {
    return this.waitFor((frame) => frame.type === type, timeoutMs);
  }

  /** Frames of this `type` received so far. */
  of(type: string): Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  /** Wait for the socket to close and return its close code. */
  async closed(timeoutMs = 5_000): Promise<number> {
    return waitUntil(() => this.closeCode, timeoutMs);
  }
}

export async function waitUntil<T>(probe: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolve after `ms`, for asserting that something does not happen. */
export function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
