/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { OutgoingMessage } from "@hocuspocus/server";
import type { Hocuspocus, connectedPayload } from "@hocuspocus/server";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { CollaborationController } from "@/controllers/collaboration.controller";
import {
  AUTHENTICATION_DEADLINE_CLOSE_CODE,
  AUTHENTICATION_DEADLINE_MS,
  MAX_PENDING_BYTES,
  MAX_PENDING_DOCUMENTS,
  MAX_PENDING_MESSAGES,
  guardCollaborationSocket,
  markDocumentAuthenticated,
  releaseDocumentOnClose,
} from "@/lib/collaboration-socket-guard";

const createSocket = () => Object.assign(new EventEmitter(), { close: vi.fn(), terminate: vi.fn() });

const frame = (documentName: string, padding = 0) =>
  Buffer.concat([
    Buffer.from(new OutgoingMessage(documentName).writeTokenSyncRequest().toUint8Array()),
    Buffer.alloc(padding),
  ]);

describe("collaboration socket limits", () => {
  let socket: ReturnType<typeof createSocket>;
  let request: IncomingMessage;

  beforeEach(() => {
    vi.useFakeTimers();
    socket = createSocket();
    request = {} as IncomingMessage;
    guardCollaborationSocket(socket as unknown as WebSocket, request);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const send = (data: unknown, count = 1) => {
    for (let index = 0; index < count; index++) socket.emit("message", data);
  };

  it("closes a socket that has not authenticated by the deadline", () => {
    vi.advanceTimersByTime(AUTHENTICATION_DEADLINE_MS - 1);
    expect(socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(socket.close).toHaveBeenCalledWith(AUTHENTICATION_DEADLINE_CLOSE_CODE, "authentication-timeout");
  });

  it("leaves a socket open once a document has authenticated", () => {
    markDocumentAuthenticated(request, "page");

    vi.advanceTimersByTime(AUTHENTICATION_DEADLINE_MS * 2);

    expect(socket.close).not.toHaveBeenCalled();
  });

  it("forgets the deadline when the socket closes first", () => {
    socket.emit("close");

    vi.advanceTimersByTime(AUTHENTICATION_DEADLINE_MS);

    expect(socket.close).not.toHaveBeenCalled();
  });

  it("allows the queued-message limit and drops the socket beyond it", () => {
    send(frame("page"), MAX_PENDING_MESSAGES);
    expect(socket.terminate).not.toHaveBeenCalled();

    send(frame("page"));
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("drops the socket when queued messages exceed the byte limit", () => {
    send(frame("page", MAX_PENDING_BYTES / 2));
    expect(socket.terminate).not.toHaveBeenCalled();

    send(frame("page", MAX_PENDING_BYTES / 2));
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("drops the socket when messages name too many documents", () => {
    for (let index = 0; index < MAX_PENDING_DOCUMENTS; index++) send(frame(`page-${index}`));
    expect(socket.terminate).not.toHaveBeenCalled();

    send(frame("one-more-page"));
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("drops a socket that sends a text message", () => {
    send("1024");
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("leaves a message it cannot decode for Hocuspocus to reject", () => {
    send(Buffer.alloc(0));
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("does not limit messages for an authenticated document", () => {
    markDocumentAuthenticated(request, "page");

    send(frame("page", MAX_PENDING_BYTES), MAX_PENDING_MESSAGES + 1);

    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("still limits other documents on an authenticated socket", () => {
    markDocumentAuthenticated(request, "page");

    send(frame("not-authenticated"), MAX_PENDING_MESSAGES + 1);

    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("counts messages again after the document connection closes", async () => {
    markDocumentAuthenticated(request, "page");
    let close: (() => void) | undefined;
    const connection = { onClose: (callback: () => void) => (close = callback) };

    await releaseDocumentOnClose({ request, connection, documentName: "page" } as unknown as connectedPayload);
    send(frame("page"), MAX_PENDING_MESSAGES + 1);
    expect(socket.terminate).not.toHaveBeenCalled();

    close?.();
    send(frame("page"), MAX_PENDING_MESSAGES + 1);
    expect(socket.terminate).toHaveBeenCalled();
  });
});

describe("CollaborationController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the socket limits to every collaboration socket", () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const handleConnection = vi.fn();
    const controller = new CollaborationController({ handleConnection } as unknown as Hocuspocus);

    controller.handleConnection(socket as unknown as WebSocket, {} as Request);
    vi.advanceTimersByTime(AUTHENTICATION_DEADLINE_MS);

    expect(handleConnection).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(AUTHENTICATION_DEADLINE_CLOSE_CODE, "authentication-timeout");
  });
});
