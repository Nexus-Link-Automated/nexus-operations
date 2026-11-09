/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { IncomingMessage as HttpIncomingMessage } from "http";
import { IncomingMessage } from "@hocuspocus/server";
import type { connectedPayload } from "@hocuspocus/server";
import type WebSocket from "ws";

// The API accepts document binaries up to 10 MB. A full sync frame can exceed the saved size slightly
// (offline edits, framing), and the store path is what reports a document as too large.
export const MAX_COLLABORATION_MESSAGE_BYTES = 16 * 1024 * 1024;

// Longer than the API client's 20s timeout, so a slow API fails the check rather than closing the socket.
export const AUTHENTICATION_DEADLINE_MS = 30_000;
// Outside the 4000-4003 range the web client treats as final, so it reconnects.
export const AUTHENTICATION_DEADLINE_CLOSE_CODE = 4408;

// Before a document is authenticated a client only sends its token, state vector, awareness and any
// keystrokes in that short window. Going over these limits drops the socket; the client reconnects and syncs.
export const MAX_PENDING_MESSAGES = 1024;
export const MAX_PENDING_BYTES = 1024 * 1024;
export const MAX_PENDING_DOCUMENTS = 8;

/**
 * Hocuspocus keeps every message that arrives before a document is authenticated, on sockets that
 * never authenticate as well. This limits how long such a socket can stay open and how much it can queue.
 */
class CollaborationSocketGuard {
  private readonly authenticatedDocuments = new Set<string>();
  private readonly pendingDocuments = new Set<string>();
  private pendingMessages = 0;
  private pendingBytes = 0;
  private readonly authenticationDeadline: NodeJS.Timeout;

  constructor(private readonly socket: WebSocket) {
    this.authenticationDeadline = setTimeout(() => {
      socket.close(AUTHENTICATION_DEADLINE_CLOSE_CODE, "authentication-timeout");
    }, AUTHENTICATION_DEADLINE_MS);
    this.authenticationDeadline.unref();

    socket.on("message", this.handleMessage);
    socket.once("close", () => clearTimeout(this.authenticationDeadline));
  }

  private handleMessage = (data: WebSocket.RawData) => {
    // The Hocuspocus protocol is binary only.
    if (!(data instanceof Uint8Array)) {
      this.socket.terminate();
      return;
    }

    let documentName: string;
    try {
      documentName = new IncomingMessage(data).readVarString();
    } catch {
      // Hocuspocus closes the socket for a message it cannot decode.
      return;
    }
    if (this.authenticatedDocuments.has(documentName)) return;

    this.pendingDocuments.add(documentName);
    this.pendingMessages += 1;
    this.pendingBytes += data.byteLength;
    if (
      this.pendingDocuments.size > MAX_PENDING_DOCUMENTS ||
      this.pendingMessages > MAX_PENDING_MESSAGES ||
      this.pendingBytes > MAX_PENDING_BYTES
    ) {
      this.socket.terminate();
    }
  };

  markAuthenticated(documentName: string) {
    clearTimeout(this.authenticationDeadline);
    this.authenticatedDocuments.add(documentName);
    this.pendingDocuments.delete(documentName);
  }

  releaseDocument(documentName: string) {
    this.authenticatedDocuments.delete(documentName);
  }
}

const guards = new WeakMap<HttpIncomingMessage, CollaborationSocketGuard>();

export const guardCollaborationSocket = (socket: WebSocket, request: HttpIncomingMessage) => {
  guards.set(request, new CollaborationSocketGuard(socket));
};

export const markDocumentAuthenticated = (request: HttpIncomingMessage, documentName: string) => {
  guards.get(request)?.markAuthenticated(documentName);
};

/**
 * A closed document can be reopened on the same socket and needs authenticating again,
 * so messages for it count against the limits once more.
 */
export const releaseDocumentOnClose = async ({ request, connection, documentName }: connectedPayload) => {
  connection.onClose(() => guards.get(request)?.releaseDocument(documentName));
};
