/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { inspect } from "node:util";
import { logger } from "@plane/logger";
import { AxiosError, AxiosHeaders } from "axios";
import type { InternalAxiosRequestConfig } from "axios";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { onAuthenticate } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { HocusPocusServerContext } from "@/types";

vi.mock("@/services/user.service", () => ({ UserService: vi.fn() }));

const COOKIE_SECRET = "cookie-secret-value";
const BEARER_SECRET = "bearer-secret-value";
const BODY_SECRET = "request-body-secret-value";
const SECRETS = [COOKIE_SECRET, BEARER_SECRET, BODY_SECRET];

const createAxiosError = (): AxiosError => {
  const config = {
    method: "patch",
    url: "/api/pages/page-1/description/",
    headers: new AxiosHeaders({ Cookie: `session-id=${COOKIE_SECRET}`, Authorization: `Bearer ${BEARER_SECRET}` }),
    data: JSON.stringify({ description_html: `<p>${BODY_SECRET}</p>` }),
  } as InternalAxiosRequestConfig;

  return new AxiosError(
    "Request failed with status code 403",
    "ERR_BAD_REQUEST",
    config,
    { _header: `PATCH / HTTP/1.1\r\nCookie: session-id=${COOKIE_SECRET}\r\n\r\n` },
    { status: 403, statusText: "Forbidden", headers: {}, config, data: { message: "Page is locked" } }
  );
};

/** Runs `log` and returns the JSON lines the real logger produced for it. */
const captureLogLines = async (log: () => unknown): Promise<string[]> => {
  const lines: string[] = [];
  const onData = (info: Record<symbol, string>) => lines.push(info[Symbol.for("message")]);
  logger.on("data", onData);
  await log();
  await new Promise((resolve) => setImmediate(resolve));
  logger.off("data", onData);
  return lines;
};

const logAndParse = async (error: unknown) => {
  const [line] = await captureLogLines(() => logger.error("Something failed", error));
  return { line, parsed: JSON.parse(line) as Record<string, any> };
};

describe("AppError", () => {
  beforeAll(() => {
    logger.transports.forEach((transport) => {
      transport.silent = true;
    });
  });

  afterAll(() => {
    logger.transports.forEach((transport) => {
      transport.silent = false;
    });
  });

  describe("context", () => {
    const context = { operation: "onAuthenticate", pageId: "page-1" };

    it.each([
      ["a standard error", new Error("boom")],
      ["an AxiosError", createAxiosError()],
      ["an aborted request", new DOMException("Aborted", "AbortError")],
      ["a thrown non-error value", 42],
      ["a string message", "boom"],
    ])("keeps the context when given %s", (_label, input) => {
      expect(new AppError(input, { context }).context).toEqual(context);
    });

    it("adds context to an error the axios interceptor already wrapped", () => {
      const wrapped = new AppError(createAxiosError());

      const appError = new AppError(wrapped, { context: { operation: "fetchDetails", pageId: "page-1" } });

      expect(appError).toBe(wrapped);
      expect(appError.context).toEqual({ operation: "fetchDetails", pageId: "page-1" });
    });

    it("merges context as an error is re-wrapped, with the latest values winning", () => {
      const inner = new AppError(new Error("boom"), {
        context: { operation: "updatePageProperties", pageId: "page-1" },
      });

      const outer = new AppError(inner, { context: { operation: "updateTitle", documentName: "doc-1" } });

      expect(outer.context).toEqual({ operation: "updateTitle", pageId: "page-1", documentName: "doc-1" });
    });

    it("keeps every key the current callers pass", () => {
      const callerKeys = { operation: "op", pageId: "page-1", documentName: "doc-1", requestId: "request-1" };

      expect(new AppError(new Error("boom"), { context: callerKeys }).context).toEqual(callerKeys);
    });

    it("strips sensitive keys at any depth without changing the caller's object", () => {
      const callerContext = {
        operation: "onAuthenticate",
        cookie: COOKIE_SECRET,
        Authorization: `Bearer ${BEARER_SECRET}`,
        "x-api-key": BEARER_SECRET,
        access_token: BEARER_SECRET,
        password: BEARER_SECRET,
        body: BODY_SECRET,
        data: { description_html: BODY_SECRET },
        description_html: BODY_SECRET,
        nested: {
          pageId: "page-1",
          headers: { Cookie: COOKIE_SECRET },
          items: [{ sessionToken: BEARER_SECRET, id: 1 }],
        },
      };

      const appError = new AppError(new Error("boom"), { context: callerContext });

      expect(appError.context).toEqual({
        operation: "onAuthenticate",
        nested: { pageId: "page-1", items: [{ id: 1 }] },
      });
      expect(callerContext.cookie).toBe(COOKIE_SECRET);
    });

    it("strips sensitive keys when the message is a string", () => {
      const appError = new AppError("boom", { code: "MY_CODE", context: { pageId: "page-1", token: BEARER_SECRET } });

      expect(appError.code).toBe("MY_CODE");
      expect(appError.context).toEqual({ pageId: "page-1" });
    });

    it("strips sensitive keys added to an already wrapped error", () => {
      const wrapped = new AppError(new Error("boom"));

      expect(new AppError(wrapped, { context: { pageId: "page-1", cookie: COOKIE_SECRET } }).context).toEqual({
        pageId: "page-1",
      });
    });

    it("does not keep objects that serialise their own secrets, and survives circular references", () => {
      const circular: Record<string, unknown> = { pageId: "page-1" };
      circular.self = circular;

      const appError = new AppError("boom", { context: { error: createAxiosError(), circular } });

      expect(appError.context?.error).toBe("[AxiosError]");
      expect(appError.context?.circular.pageId).toBe("page-1");
      for (const secret of SECRETS) expect(JSON.stringify(appError.context)).not.toContain(secret);
    });
  });

  describe("cause and stack", () => {
    it.each([
      ["a standard error", new TypeError("boom")],
      ["an AxiosError", createAxiosError()],
      ["an aborted request", new DOMException("Aborted", "AbortError")],
    ])("keeps %s as a non-enumerable cause and uses its stack", (_label, original) => {
      const appError = new AppError(original);

      expect(appError.cause).toBe(original);
      expect(Object.keys(appError)).not.toContain("cause");
      expect(appError.stack).toBe(original.stack);
    });

    it("leaves message, code and status as before", () => {
      const appError = new AppError(createAxiosError(), { context: { pageId: "page-1" } });

      expect(appError.name).toBe("AppError");
      expect(appError.message).toBe("Page is locked");
      expect(appError.code).toBe("ERR_BAD_REQUEST");
      expect(appError.statusCode).toBe(403);
      expect(appError.method).toBe("PATCH");
      expect(appError.url).toBe("/api/pages/page-1/description/");
    });

    it.each([
      ["a string message", "boom"],
      ["a thrown non-error value", { config: { headers: { Cookie: COOKIE_SECRET } } }],
    ])("sets no cause for %s", (_label, input) => {
      expect(new AppError(input).cause).toBeUndefined();
    });
  });

  describe("logged output", () => {
    it("includes the context and the origin stack", async () => {
      const original = new TypeError("boom");

      const { parsed } = await logAndParse(new AppError(original, { context: { operation: "onAuthenticate" } }));

      expect(parsed.context).toEqual({ operation: "onAuthenticate" });
      expect(parsed.stack).toBe(original.stack);
    });

    it("writes a standard error cause as readable fields, not {}", async () => {
      const original = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

      const { parsed } = await logAndParse(new AppError(original));

      expect(parsed.cause).toEqual({ name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED" });
    });

    it("writes the identifying fields of an AxiosError cause without its request", async () => {
      const { line, parsed } = await logAndParse(new AppError(createAxiosError(), { context: { pageId: "page-1" } }));

      expect(parsed.cause).toEqual({
        name: "AxiosError",
        message: "Request failed with status code 403",
        code: "ERR_BAD_REQUEST",
      });
      expect(parsed.context).toEqual({ pageId: "page-1" });
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    });

    it("follows a chain of causes without their requests", async () => {
      const root = new Error("socket hang up");
      const axiosError = Object.assign(createAxiosError(), { cause: root });

      const { line, parsed } = await logAndParse(new AppError(axiosError));

      expect(parsed.cause.cause).toEqual({ name: "Error", message: "socket hang up", stack: root.stack });
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    });

    it("does not log sensitive context", async () => {
      const appError = new AppError(new Error("boom"), {
        context: {
          pageId: "page-1",
          cookie: COOKIE_SECRET,
          headers: { Authorization: BEARER_SECRET },
          body: BODY_SECRET,
        },
      });

      const { line } = await logAndParse(appError);

      for (const secret of SECRETS) expect(line).not.toContain(secret);
    });

    it("does not log the token when onAuthenticate cannot parse it", async () => {
      const token = "cookie-secret";

      const lines = await captureLogLines(() =>
        expect(
          onAuthenticate({
            requestHeaders: {},
            requestParameters: new URLSearchParams(),
            context: {} as HocusPocusServerContext,
            token,
          })
        ).rejects.toThrow("Credentials not provided")
      );

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).context).toEqual({ operation: "onAuthenticate" });
      expect(JSON.parse(lines[0]).code).toBe("SyntaxError");
      for (const line of lines) expect(line).not.toContain(token);
    });

    it("does not print the request through util.inspect, which console.error uses", () => {
      const appError = new AppError(createAxiosError(), { context: { pageId: "page-1" } });

      const output = inspect(appError, { depth: null });

      expect(output).toContain("Request failed with status code 403");
      expect(output).toContain("page-1");
      for (const secret of SECRETS) expect(output).not.toContain(secret);
    });
  });

  describe("serialising for anything other than the logger", () => {
    it("does not include the cause or stack in JSON", () => {
      const output = JSON.stringify(new AppError(createAxiosError(), { context: { pageId: "page-1" } }));

      expect(JSON.parse(output)).not.toHaveProperty("cause");
      expect(JSON.parse(output)).not.toHaveProperty("stack");
      for (const secret of SECRETS) expect(output).not.toContain(secret);
    });
  });
});
