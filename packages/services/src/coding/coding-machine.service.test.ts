/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import { CodingJobServiceError } from "./coding-job.service";
import { CodingMachineService } from "./coding-machine.service";

type TSpied = {
  get: () => Promise<unknown>;
  post: () => Promise<unknown>;
  patch: () => Promise<unknown>;
  delete: () => Promise<unknown>;
};

function service() {
  const machines = new CodingMachineService("http://api");
  const spied = machines as unknown as TSpied;
  return {
    machines,
    get: vi.spyOn(spied, "get"),
    post: vi.spyOn(spied, "post"),
    patch: vi.spyOn(spied, "patch"),
    remove: vi.spyOn(spied, "delete"),
  };
}

describe("CodingMachineService", () => {
  it("uses the workspace's session routes", async () => {
    const { machines, get, post, patch, remove } = service();
    get.mockResolvedValue({ data: [{ id: "m1" }] });
    post.mockResolvedValue({ data: { id: "m1", join_code: "AAAA-BBBB-CCCC-DDDD" } });
    patch.mockResolvedValue({ data: { id: "m1", name: "Laptop" } });
    remove.mockResolvedValue({ status: 204 });

    expect(await machines.list("acme")).toEqual([{ id: "m1" }]);
    expect(get).toHaveBeenLastCalledWith("/api/workspaces/acme/coding-machines/");
    await machines.listAll("acme");
    expect(get).toHaveBeenLastCalledWith("/api/workspaces/acme/coding-machines/all/");

    expect((await machines.create("acme", { name: "Laptop" })).join_code).toBe("AAAA-BBBB-CCCC-DDDD");
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/coding-machines/", { name: "Laptop" });
    await machines.approve("acme", "m1");
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/coding-machines/m1/approve/", {});
    await machines.revoke("acme", "m1");
    expect(post).toHaveBeenLastCalledWith("/api/workspaces/acme/coding-machines/m1/revoke/", {});

    await machines.rename("acme", "m1", { name: "Laptop" });
    expect(patch).toHaveBeenCalledWith("/api/workspaces/acme/coding-machines/m1/", { name: "Laptop" });
    expect(await machines.remove("acme", "m1")).toBeUndefined();
    expect(remove).toHaveBeenCalledWith("/api/workspaces/acme/coding-machines/m1/");
  });

  it("throws the API's refusal with its status and code", async () => {
    const { machines, post } = service();
    post.mockRejectedValue({ response: { status: 409, data: { error: "Not joined.", code: "MACHINE_NOT_JOINED" } } });

    const error = await machines.approve("acme", "m1").catch((e) => e);

    expect(error).toBeInstanceOf(CodingJobServiceError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("MACHINE_NOT_JOINED");
  });
});
