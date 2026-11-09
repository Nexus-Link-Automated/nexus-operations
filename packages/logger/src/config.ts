/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { LoggerOptions } from "winston";
import { createLogger, format, transports } from "winston";

type TLoggedCause = {
  name: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: TLoggedCause;
};

const MAX_CAUSE_DEPTH = 5;

const summarizeCause = (error: Error, parentStack: unknown, depth = 1): TLoggedCause => {
  const summary: TLoggedCause = { name: error.name, message: error.message };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") summary.code = code;
  if (error.stack && error.stack !== parentStack) summary.stack = error.stack;
  if (error.cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
    summary.cause = summarizeCause(error.cause, error.stack, depth + 1);
  }
  return summary;
};

/**
 * Winston passes an error's `cause` straight to the JSON format, where a plain Error becomes `{}`
 * and an AxiosError's toJSON dumps the request config, including its cookies and body.
 * Log a fixed set of fields instead.
 */
const serializeCause = format((info) => {
  if (info.cause instanceof Error) info.cause = summarizeCause(info.cause, info.stack);
  return info;
});

export const loggerConfig: LoggerOptions = {
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss:ms",
    }),
    serializeCause(),
    format.json()
  ),
  transports: [new transports.Console()],
};

export const logger = createLogger(loggerConfig);
