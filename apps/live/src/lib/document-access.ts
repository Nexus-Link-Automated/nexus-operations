/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { IncomingMessage, MessageType, OutgoingMessage } from "@hocuspocus/server";
import type { Connection, beforeHandleMessagePayload } from "@hocuspocus/server";
import { messageYjsUpdate } from "y-protocols/sync";
import { logger } from "@plane/logger";
import { EUserProjectRoles } from "@plane/types";
import { AppError } from "@/lib/errors";
import { getPageService } from "@/services/page/handler";
import type { HocusPocusServerContext } from "@/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same characters as the Django SlugField that holds workspace slugs.
const WORKSPACE_SLUG_PATTERN = /^[-a-zA-Z0-9_]+$/;

// An editing connection is checked again at most this often, and only when it sends an edit.
const EDITOR_RECHECK_INTERVAL_MS = 30_000;
// A read-only connection only sends edits once the client believes the page became editable.
const READ_ONLY_RECHECK_INTERVAL_MS = 1_000;

const ACCESS_LOST_STATUS_CODES = new Set([401, 403, 404]);
// Outside the 4000-4003 range the web client treats as final, so it reconnects and shows the refusal.
const ACCESS_LOST_CLOSE_CODE = 4403;

/**
 * Asks the API what this user may do with this document, using their own credentials.
 * The API scopes the page to the workspace and project in its URL, so a successful answer
 * also confirms that the workspace and project sent by the client belong to this document.
 * Rejects when the user may not open the document.
 */
export const resolveDocumentAccess = async (
  documentName: string,
  context: HocusPocusServerContext
): Promise<{ readOnly: boolean }> => {
  const { workspaceSlug, projectId, userId } = context;

  // These values become part of API paths, so they must not be able to select a different endpoint.
  if (
    !UUID_PATTERN.test(documentName) ||
    !UUID_PATTERN.test(projectId ?? "") ||
    !WORKSPACE_SLUG_PATTERN.test(workspaceSlug ?? "")
  ) {
    throw new AppError("Invalid document identifiers", { code: "DOCUMENT_ACCESS_INVALID", statusCode: 403 });
  }

  const service = getPageService(context.documentType, context);
  const [page, role] = await Promise.all([
    service.fetchDetails(documentName, { trackVisit: false }),
    service.fetchCurrentUserRole(),
  ]);
  if (page.id !== documentName) {
    throw new AppError("Page does not match the requested document", {
      code: "DOCUMENT_ACCESS_MISMATCH",
      statusCode: 403,
    });
  }

  // Same rule as ProjectPagePermission and PagesDescriptionViewSet.partial_update in the API.
  const canEdit = page.owned_by === userId || role >= EUserProjectRoles.MEMBER;
  return { readOnly: !canEdit || page.is_locked || Boolean(page.archived_at) };
};

const isDocumentEdit = (data: Uint8Array): boolean => {
  const message = new IncomingMessage(data);
  message.readVarString();
  const type = message.readVarUint();
  return (type === MessageType.Sync || type === MessageType.SyncReply) && message.readVarUint() === messageYjsUpdate;
};

const refreshConnectionAccess = async (
  connection: Connection,
  documentName: string,
  context: HocusPocusServerContext
): Promise<void> => {
  try {
    const { readOnly } = await resolveDocumentAccess(documentName, context);
    const becameEditable = connection.readOnly && !readOnly;
    connection.readOnly = readOnly;
    if (becameEditable) {
      // Edits refused while read-only are never resent, so ask the client for everything the server is missing.
      connection.send(
        new OutgoingMessage(documentName).createSyncMessage().writeFirstSyncStepFor(connection.document).toUint8Array()
      );
    }
  } catch (error) {
    const appError = new AppError(error, { context: { operation: "refreshConnectionAccess", documentName } });
    if (appError.statusCode !== undefined && ACCESS_LOST_STATUS_CODES.has(appError.statusCode)) {
      connection.readOnly = true;
      connection.webSocket.close(ACCESS_LOST_CLOSE_CODE, "permission-denied");
      return;
    }
    // A failed lookup says nothing about the user's access, so the connection keeps its current mode.
    logger.warn("Could not refresh document access", appError);
  }
};

/**
 * Keeps a connection's mode current while it is open, without calling the API for idle connections.
 * This is how an editor whose page was locked when they joined can edit again after it is unlocked or restored.
 * Concurrent edits wait for the same lookup, so they are still applied in the order they arrived.
 */
export const recheckDocumentAccess = async ({
  connection,
  context,
  documentName,
  update,
}: beforeHandleMessagePayload): Promise<void> => {
  if (!isDocumentEdit(update)) return;

  const connectionContext = context as HocusPocusServerContext;
  const interval = connection.readOnly ? READ_ONLY_RECHECK_INTERVAL_MS : EDITOR_RECHECK_INTERVAL_MS;
  if (Date.now() - (connectionContext.accessCheckedAt ?? 0) < interval) return;

  connectionContext.accessRecheck ??= refreshConnectionAccess(connection, documentName, connectionContext).finally(
    () => {
      connectionContext.accessCheckedAt = Date.now();
      connectionContext.accessRecheck = undefined;
    }
  );
  await connectionContext.accessRecheck;
};
