/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { CodingJobService, CodingJobServiceError } from "./coding-job.service";

type TSpied = { get: () => Promise<unknown>; post: () => Promise<unknown>; patch: () => Promise<unknown> };

function service() {
  const coding = new CodingJobService("http://api");
  const get = vi.spyOn(coding as unknown as TSpied, "get");
  const post = vi.spyOn(coding as unknown as TSpied, "post");
  const patch = vi.spyOn(coding as unknown as TSpied, "patch");
  return { coding, get, post, patch };
}

describe("CodingJobService", () => {
  it("uses the session routes for jobs and settings", async () => {
    const { coding, get, post, patch } = service();
    get.mockResolvedValue({ data: { results: [{ id: "j1" }] } });
    post.mockResolvedValue({ data: { id: "j2" } });
    patch.mockResolvedValue({ data: { configured: true } });

    expect(await coding.list("acme", "p1", "w1")).toEqual([{ id: "j1" }]);
    expect(get).toHaveBeenCalledWith("/api/workspaces/acme/projects/p1/work-items/w1/coding-jobs/");

    await coding.start("acme", "p1", "w1", { action: "fix_bug", agent: "codex" });
    expect(post).toHaveBeenCalledWith("/api/workspaces/acme/projects/p1/work-items/w1/coding-jobs/", {
      action: "fix_bug",
      agent: "codex",
    });
    await coding.cancel("acme", "p1", "w1", "j1");
    expect(post).toHaveBeenCalledWith("/api/workspaces/acme/projects/p1/work-items/w1/coding-jobs/j1/cancel/", {});
    await coding.retry("acme", "p1", "w1", "j1");
    expect(post).toHaveBeenCalledWith("/api/workspaces/acme/projects/p1/work-items/w1/coding-jobs/j1/retry/", {});
    await coding.start("acme", "p1", "w1", { action: "fix_bug", agent: "claude", machine: "m1" });
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/projects/p1/work-items/w1/coding-jobs/", {
      action: "fix_bug",
      agent: "claude",
      machine: "m1",
    });
    await coding.retry("acme", "p1", "w1", "j1", { machine: null });
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/projects/p1/work-items/w1/coding-jobs/j1/retry/", {
      machine: null,
    });

    await coding.updateSettings("acme", "p1", { enabled: true });
    expect(patch).toHaveBeenCalledWith("/api/workspaces/acme/projects/p1/coding-settings/", { enabled: true });
  });

  it("throws the API's refusal with its status, code and message", async () => {
    const { coding, post } = service();
    post.mockRejectedValue({
      response: { status: 409, data: { error: "Already running.", code: "JOB_ACTIVE", job_id: "j1" } },
    });

    const error = await coding.start("acme", "p1", "w1", { action: "fix_bug", agent: "codex" }).catch((e) => e);

    expect(error).toBeInstanceOf(CodingJobServiceError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("JOB_ACTIVE");
    expect(error.message).toBe("Already running.");
  });

  it("keeps field errors from a 400", async () => {
    const { coding, patch } = service();
    patch.mockRejectedValue({
      response: { status: 400, data: { error: "The request is not valid.", errors: { repo_url: ["Bad."] } } },
    });

    const error = await coding.updateSettings("acme", "p1", { repo_url: "x" }).catch((e) => e);

    expect(error.code).toBeNull();
    expect(error.fieldErrors).toEqual({ repo_url: ["Bad."] });
  });
});
