/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
import type { TCodingMachine } from "@plane/types";
import { fakeMachineService, makeCreated, makeMachine } from "@/components/coding-machines/test-utils";
import { CodingMachineStore } from "./coding-machine.store";

describe("CodingMachineStore", () => {
  it("loads the user's own machines and the workspace's, per workspace", async () => {
    const service = fakeMachineService({
      list: vi.fn().mockResolvedValue([makeMachine("m1")]),
      listAll: vi.fn().mockResolvedValue([makeMachine("m1"), makeMachine("m2", { owner: "other" })]),
    });
    const store = new CodingMachineStore({ service });

    await store.fetchMachines("acme");
    await store.fetchAllMachines("acme");

    expect(service.list).toHaveBeenCalledWith("acme");
    expect(store.getMachines("acme")?.map((m) => m.id)).toEqual(["m1"]);
    expect(store.getAllMachines("acme")?.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(store.getMachines("other")).toBeUndefined();
  });

  it("adds a machine without keeping its join code", async () => {
    const service = fakeMachineService({ create: vi.fn().mockResolvedValue(makeCreated("m2", "Laptop")) });
    const store = new CodingMachineStore({ service });
    await store.fetchMachines("acme");

    const created = await store.createMachine("acme", "Laptop");

    expect(service.create).toHaveBeenCalledWith("acme", { name: "Laptop" });
    expect(created.join_code).toBe("ABCD-EFGH-JKLM-NPQR");
    expect(store.getMachines("acme")?.map((m) => m.name)).toEqual(["Laptop"]);
    expect(store.getMachines("acme")?.[0]).not.toHaveProperty("join_code");
  });

  it("renames, approves and removes in place", async () => {
    const service = fakeMachineService({
      list: vi.fn().mockResolvedValue([makeMachine("m1"), makeMachine("m2", { state: "awaiting_approval" })]),
      rename: vi.fn().mockResolvedValue(makeMachine("m1", { name: "Desk" })),
      approve: vi.fn().mockResolvedValue(makeMachine("m2")),
    });
    const store = new CodingMachineStore({ service });
    await store.fetchMachines("acme");

    await store.renameMachine("acme", "m1", "Desk");
    await store.approveMachine("acme", "m2");
    expect(store.getMachines("acme")?.map((m) => [m.name, m.state])).toEqual([
      ["Desk", "active"],
      ["Machine m2", "active"],
    ]);

    await store.removeMachine("acme", "m1");
    expect(service.remove).toHaveBeenCalledWith("acme", "m1");
    expect(store.getMachines("acme")?.map((m) => m.id)).toEqual(["m2"]);
  });

  it("revokes in the workspace list without adding someone else's machine to the user's own", async () => {
    const service = fakeMachineService({
      list: vi.fn().mockResolvedValue([makeMachine("m1")]),
      listAll: vi.fn().mockResolvedValue([makeMachine("m1"), makeMachine("m2", { owner: "other" })]),
      revoke: vi.fn().mockResolvedValue(makeMachine("m2", { owner: "other", state: "revoked" })),
    });
    const store = new CodingMachineStore({ service });
    await store.fetchMachines("acme");
    await store.fetchAllMachines("acme");

    await store.revokeMachine("acme", "m2");

    expect(store.getAllMachines("acme")?.find((m) => m.id === "m2")?.state).toBe("revoked");
    expect(store.getMachines("acme")?.map((m) => m.id)).toEqual(["m1"]);
  });

  it("drops a list that was requested before a change it does not show", async () => {
    const pending: { answer?: (machines: TCodingMachine[]) => void } = {};
    const service = fakeMachineService({
      list: vi.fn().mockResolvedValueOnce([makeMachine("m1")]),
    });
    const store = new CodingMachineStore({ service });
    await store.fetchMachines("acme");
    service.list.mockReturnValueOnce(
      new Promise((resolve) => {
        pending.answer = resolve;
      })
    );

    const stale = store.fetchMachines("acme");
    await store.removeMachine("acme", "m1");
    pending.answer?.([makeMachine("m1")]);
    await stale;

    expect(store.getMachines("acme")).toEqual([]);
  });

  it("throws the refusal", async () => {
    const error = new Error("forbidden");
    const store = new CodingMachineStore({ service: fakeMachineService({ list: vi.fn().mockRejectedValue(error) }) });
    await expect(store.fetchMachines("acme")).rejects.toBe(error);
    expect(store.getMachines("acme")).toBeUndefined();
  });
});
