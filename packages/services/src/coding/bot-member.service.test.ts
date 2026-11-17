/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { BotMemberService } from "./bot-member.service";
import { CodingJobServiceError } from "./coding-job.service";

type TSpied = {
  get: () => Promise<unknown>;
  post: () => Promise<unknown>;
  patch: () => Promise<unknown>;
  delete: () => Promise<unknown>;
};

function service() {
  const bots = new BotMemberService("http://api");
  const spied = bots as unknown as TSpied;
  return {
    bots,
    get: vi.spyOn(spied, "get"),
    post: vi.spyOn(spied, "post"),
    patch: vi.spyOn(spied, "patch"),
    remove: vi.spyOn(spied, "delete"),
  };
}

describe("BotMemberService", () => {
  it("uses the workspace's session routes", async () => {
    const { bots, get, post, patch, remove } = service();
    get.mockResolvedValue({ data: [{ id: "b1" }] });
    post.mockResolvedValue({ data: { id: "b1", token: "plane_api_x" } });
    patch.mockResolvedValue({ data: { id: "b1", name: "Triage" } });
    remove.mockResolvedValue({ status: 204 });

    expect(await bots.list("acme")).toEqual([{ id: "b1" }]);
    expect(get).toHaveBeenLastCalledWith("/api/workspaces/acme/bot-members/");

    expect((await bots.create("acme", { name: "Triage", role: 15, description: "Sorts bugs" })).token).toBe(
      "plane_api_x"
    );
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/bot-members/", {
      name: "Triage",
      role: 15,
      description: "Sorts bugs",
    });

    await bots.update("acme", "b1", { role: 5 });
    expect(patch).toHaveBeenLastCalledWith("/api/workspaces/acme/bot-members/b1/", { role: 5 });

    await bots.rotateToken("acme", "b1");
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/bot-members/b1/token/", {});

    expect(await bots.remove("acme", "b1")).toBeUndefined();
    expect(remove).toHaveBeenLastCalledWith("/api/workspaces/acme/bot-members/b1/");
  });

  it("throws the API's refusal with its status and code", async () => {
    const { bots, post } = service();
    post.mockRejectedValue({ response: { status: 409, data: { error: "At most 20.", code: "BOT_LIMIT" } } });

    const error = await bots.create("acme", { name: "Triage" }).catch((e) => e);

    expect(error).toBeInstanceOf(CodingJobServiceError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("BOT_LIMIT");
    expect(error.message).toBe("At most 20.");
  });
});
