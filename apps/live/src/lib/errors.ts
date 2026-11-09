/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { inspect } from "node:util";
import type { AxiosError } from "axios";

// Context keys that must never reach the logs, matched at any depth.
const SENSITIVE_CONTEXT_KEY =
  /cookie|token|authorization|bearer|password|passwd|secret|api[-_]?key|session|credential|^(?:auth|headers?|body|data|payload|config|request|response|content)$|^description_/i;
const MAX_CONTEXT_DEPTH = 4;

const sanitizeContextValue = (value: unknown, depth: number): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_CONTEXT_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) return value.map((item) => sanitizeContextValue(item, depth + 1));

  // Only plain objects are copied: instances such as AxiosError or Buffer serialise their own internals.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `[${value.constructor.name}]`;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_CONTEXT_KEY.test(key))
      .map(([key, item]) => [key, sanitizeContextValue(item, depth + 1)])
  );
};

const sanitizeContext = (context: AppError["context"]): AppError["context"] =>
  context && (sanitizeContextValue(context, 0) as AppError["context"]);

/**
 * Application error class that sanitizes and standardizes errors across the app.
 * Extracts only essential information from AxiosError to prevent massive log bloat
 * and sensitive data leaks (cookies, tokens, etc).
 *
 * A wrapped error is kept as a non-enumerable `cause`, and its stack replaces this error's.
 * `@plane/logger` reduces the cause to safe fields; never log `cause` directly, as an
 * AxiosError carries the request's headers and body.
 *
 * Usage:
 *   new AppError("Simple error message")
 *   new AppError("Custom error", { code: "MY_CODE", statusCode: 400 })
 *   new AppError(axiosError)  // Auto-extracts essential info
 *   new AppError(anyError)    // Works with any error type
 */
export class AppError extends Error {
  statusCode?: number;
  method?: string;
  url?: string;
  code?: string;
  context?: Record<string, any>;

  constructor(messageOrError: string | unknown, data?: Partial<Omit<AppError, "name" | "message">>) {
    // Handle error objects - extract essential info
    const error = messageOrError;

    // Already AppError - return immediately for performance (no need to re-process)
    // Most service errors arrive here, wrapped by the axios response interceptor, so keep the caller's context
    if (error instanceof AppError) {
      if (data?.context) {
        error.context = { ...error.context, ...sanitizeContext(data.context) };
      }
      return error;
    }

    // Handle string message (simple case like regular Error)
    if (typeof messageOrError === "string") {
      super(messageOrError);
      this.name = "AppError";
      if (data) {
        Object.assign(this, data);
        this.context = sanitizeContext(data.context);
      }
      return;
    }

    // AxiosError - extract ONLY essential info (no config, no headers, no cookies)
    if (error && typeof error === "object" && "isAxiosError" in error) {
      const axiosError = error as AxiosError;
      const responseData = axiosError.response?.data as any;
      super(responseData?.message || axiosError.message, { cause: axiosError });
      this.name = "AppError";
      this.statusCode = axiosError.response?.status;
      this.method = axiosError.config?.method?.toUpperCase();
      this.url = axiosError.config?.url;
      this.code = axiosError.code;
      this.stack = axiosError.stack ?? this.stack;
      this.context = sanitizeContext(data?.context);
      return;
    }

    // DOMException (AbortError from cancelled requests)
    if (error instanceof DOMException && error.name === "AbortError") {
      super(error.message, { cause: error });
      this.name = "AppError";
      this.code = "ABORT_ERROR";
      this.stack = error.stack ?? this.stack;
      this.context = sanitizeContext(data?.context);
      return;
    }

    // Standard Error objects
    if (error instanceof Error) {
      super(error.message, { cause: error });
      this.name = "AppError";
      this.code = error.name;
      this.stack = error.stack ?? this.stack;
      this.context = sanitizeContext(data?.context);
      return;
    }

    // Unknown error types - safe fallback
    super("Unknown error occurred");
    this.name = "AppError";
    this.context = sanitizeContext(data?.context);
  }

  /**
   * console.error, including Hocuspocus's handling of thrown errors, prints through util.inspect,
   * which would otherwise walk `cause` and print an AxiosError's request headers and body.
   */
  [inspect.custom]() {
    const printable = new Error(this.message);
    printable.stack = this.stack;
    return Object.assign(printable, this);
  }
}
