/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { PERMISSION_LEVELS, clampPermissionLevel, type PermissionLevel } from "@plane/agent-runner-protocol";
import express, { type Router } from "express";
import { z } from "zod";

import type { DmTurnAdmission, DmTurnRequest } from "./dm-session.ts";
import type { Logger } from "./logger.ts";
import { BRIDGE_SECRET_HEADER } from "./plane-api.ts";

/** Where the internal routes are mounted: at the root, never under the public base path. */
export const INTERNAL_PATH = "/internal";

const MAX_PROMPT_CHARS = 100_000;
export const MAX_CHANNEL_SESSION_MS = 60 * 60_000;

/** A session the API asks for when an agent is @mentioned in a channel. */
export interface ChannelSessionRequest {
  readonly runId: string;
  readonly userId: string;
  readonly workspaceSlug: string;
  readonly agentId: string;
  readonly permissionLevel: PermissionLevel;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export type ChannelSessionAdmission = "accepted" | "busy" | "shutting_down";

/**
 * The most a channel session may do, whatever it is asked to: nobody can answer its permission prompts, and its prompt
 * holds other members' messages. The API caps the level the same way; this holds even if it doesn't.
 */
export const CHANNEL_MAX_PERMISSION_LEVEL: PermissionLevel = "ask_writes";

const bodySchema = z.object({
  run_id: z.string().regex(/^[0-9a-f]{32}$/),
  user_id: z.uuid(),
  workspace_slug: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  agent_id: z.uuid(),
  permission_level: z.enum(PERMISSION_LEVELS),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_CHANNEL_SESSION_MS)
    .default(5 * 60_000),
});

const RUN_ID = z.string().regex(/^[0-9a-f]{32}$/);
const timeoutMs = z
  .number()
  .int()
  .min(1_000)
  .max(MAX_CHANNEL_SESSION_MS)
  .default(5 * 60_000);

const dmTurnSchema = z.object({
  run_id: RUN_ID,
  channel_id: z.uuid(),
  user_id: z.uuid(),
  workspace_slug: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  agent_id: z.uuid(),
  permission_level: z.enum(PERMISSION_LEVELS),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  primer: z.string().min(1).max(MAX_PROMPT_CHARS),
  session_ref: z.string().min(1).max(255).nullable().default(null),
  timeout_ms: timeoutMs,
});

const dmParams = z.object({
  channelId: z.uuid(),
  requestId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});
const dmAnswerSchema = z.object({ run_id: RUN_ID, option_id: z.string().min(1).max(200) });
const dmCancelSchema = z.object({ run_id: RUN_ID });

function secretMatches(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  // Hash both, so the comparison takes the same time whatever the lengths.
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

export interface InternalRouterOptions {
  /** `AGENT_BRIDGE_SECRET`: the API sends it in `X-Agent-Bridge-Secret`. */
  readonly secret: string;
  /** Take the session on (or refuse it at once). The session itself runs after the answer. */
  readonly startChannelSession: (request: ChannelSessionRequest) => ChannelSessionAdmission;
  /** Take an agent DM turn on (or refuse it at once). The turn runs after the answer. */
  readonly startDmTurn: (request: DmTurnRequest) => DmTurnAdmission;
  /** Answer a permission prompt of the DM's running turn. */
  readonly answerDmPermission: (
    channelId: string,
    runId: string,
    requestId: string,
    optionId: string
  ) => "answered" | "not_found" | "bad_option";
  /** Stop the DM's running turn; false if `runId` isn't the one running. */
  readonly cancelDmTurn: (channelId: string, runId: string) => boolean;
  readonly log: Logger;
}

/**
 * Service-to-service routes for the Plane API, behind the shared secret. Mounted at `/internal`,
 * outside the base path the reverse proxy forwards, so they are reachable on the internal network
 * only.
 *
 * `POST /internal/channel-sessions` takes `{run_id, user_id, workspace_slug, agent_id,
 * permission_level, prompt, timeout_ms}` and answers 202 at once; the outcome goes back to the
 * API's `POST /api/internal/chat/agent-replies/`.
 *
 * `POST /internal/dm-turns` takes one turn of an agent DM (`{run_id, channel_id, user_id, workspace_slug, agent_id,
 * permission_level, prompt, primer, session_ref, timeout_ms}`) and answers 202 at once (409 while that DM has a turn
 * running). `POST /internal/dm-turns/<channel_id>/permissions/<request_id>` `{run_id, option_id}` answers one of its
 * permission prompts (204, or 404 once it is no longer pending), and `POST /internal/dm-turns/<channel_id>/cancel`
 * `{run_id}` stops it (202, or 404).
 */
export function internalRouter(options: InternalRouterOptions): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!secretMatches(req.get(BRIDGE_SECRET_HEADER) ?? "", options.secret)) {
      options.log.warn("agent-bridge: refused an internal request without the shared secret", { path: req.path });
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  });
  router.post("/channel-sessions", express.json({ limit: "512kb" }), (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid channel session request" });
      return;
    }
    const body = parsed.data;
    const admission = options.startChannelSession({
      runId: body.run_id,
      userId: body.user_id,
      workspaceSlug: body.workspace_slug,
      agentId: body.agent_id,
      permissionLevel: clampPermissionLevel(body.permission_level, CHANNEL_MAX_PERMISSION_LEVEL),
      prompt: body.prompt,
      timeoutMs: body.timeout_ms,
    });
    if (admission === "busy") {
      res.status(429).json({ error: "Too many agent sessions" });
      return;
    }
    if (admission === "shutting_down") {
      res.status(503).json({ error: "Shutting down" });
      return;
    }
    res.status(202).json({ accepted: true });
  });
  router.post("/dm-turns", express.json({ limit: "512kb" }), (req, res) => {
    const parsed = dmTurnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid agent DM turn request" });
      return;
    }
    const body = parsed.data;
    const admission = options.startDmTurn({
      runId: body.run_id,
      channelId: body.channel_id,
      userId: body.user_id,
      workspaceSlug: body.workspace_slug,
      agentId: body.agent_id,
      permissionLevel: body.permission_level,
      prompt: body.prompt,
      primer: body.primer,
      sessionRef: body.session_ref,
      timeoutMs: body.timeout_ms,
    });
    if (admission === "busy") {
      res.status(429).json({ error: "Too many agent sessions" });
      return;
    }
    if (admission === "conflict") {
      res.status(409).json({ error: "A turn is already running in this conversation" });
      return;
    }
    if (admission === "shutting_down") {
      res.status(503).json({ error: "Shutting down" });
      return;
    }
    res.status(202).json({ accepted: true });
  });
  router.post("/dm-turns/:channelId/permissions/:requestId", express.json({ limit: "16kb" }), (req, res) => {
    const params = dmParams.safeParse(req.params);
    const parsed = dmAnswerSchema.safeParse(req.body);
    if (!params.success || !params.data.requestId || !parsed.success) {
      res.status(400).json({ error: "Invalid answer" });
      return;
    }
    const result = options.answerDmPermission(
      params.data.channelId,
      parsed.data.run_id,
      params.data.requestId,
      parsed.data.option_id
    );
    if (result === "not_found") {
      res.status(404).json({ error: "No such pending permission prompt" });
      return;
    }
    if (result === "bad_option") {
      res.status(400).json({ error: "Not one of the prompt's options" });
      return;
    }
    res.status(204).end();
  });
  router.post("/dm-turns/:channelId/cancel", express.json({ limit: "16kb" }), (req, res) => {
    const params = dmParams.safeParse(req.params);
    const parsed = dmCancelSchema.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid cancel request" });
      return;
    }
    if (!options.cancelDmTurn(params.data.channelId, parsed.data.run_id)) {
      res.status(404).json({ error: "No such running turn" });
      return;
    }
    res.status(202).json({ cancelled: true });
  });
  // express.json answers a body it can't parse with an error; keep it a plain 400.
  router.use(
    (error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status && error.status < 500 ? error.status : 400).json({ error: "Invalid request" });
    }
  );
  return router;
}
