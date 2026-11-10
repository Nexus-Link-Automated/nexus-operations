/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EStartOfTheWeek } from "@plane/types";
import type { TUserProfile } from "@plane/types";
import type { CoreRootStore } from "../root.store";
import { ProfileStore } from "./profile.store";

const setLanguage = vi.hoisted(() => vi.fn());

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/i18n")>()),
  setLanguage,
}));

const makeStore = (updateCurrentUserProfile: (data: Partial<TUserProfile>) => Promise<TUserProfile>) => {
  const store = new ProfileStore({} as CoreRootStore);
  store.userService = { updateCurrentUserProfile } as unknown as ProfileStore["userService"];
  store.data.language = "en";
  return store;
};

beforeEach(() => {
  setLanguage.mockClear();
});

describe("ProfileStore.updateUserProfile", () => {
  it("rejects and puts the previous value back when the save fails", async () => {
    const failure = { error: "server refused" };
    const store = makeStore(() => Promise.reject(failure));

    await expect(store.updateUserProfile({ start_of_the_week: EStartOfTheWeek.MONDAY })).rejects.toBe(failure);

    expect(store.data.start_of_the_week).toBe(EStartOfTheWeek.SUNDAY);
    expect(store.error?.status).toBe("user-profile-update-error");
  });

  it("restores nested values, not a reference to the changed object", async () => {
    const store = makeStore(() => Promise.reject(new Error("server refused")));
    const before = { ...store.data.onboarding_step };

    await expect(
      store.updateUserProfile({ onboarding_step: { ...before, profile_complete: true } })
    ).rejects.toBeDefined();

    expect(store.data.onboarding_step).toEqual(before);
  });

  it("switches the interface language back when a language change fails", async () => {
    const store = makeStore(() => Promise.reject(new Error("server refused")));

    await expect(store.updateUserProfile({ language: "fr" })).rejects.toBeDefined();

    expect(store.data.language).toBe("en");
    expect(setLanguage.mock.calls).toEqual([["fr"], ["en"]]);
  });

  it("leaves fields it did not change alone when rolling back", async () => {
    let failRequest!: (reason: unknown) => void;
    const store = makeStore(
      () =>
        new Promise<TUserProfile>((_resolve, reject) => {
          failRequest = reject;
        })
    );

    const pending = store.updateUserProfile({ start_of_the_week: EStartOfTheWeek.MONDAY });
    store.mutateUserProfile({ is_tour_completed: true });
    failRequest(new Error("server refused"));

    await expect(pending).rejects.toBeDefined();
    expect(store.data.start_of_the_week).toBe(EStartOfTheWeek.SUNDAY);
    expect(store.data.is_tour_completed).toBe(true);
  });

  it("keeps the new value and resolves with the saved profile on success", async () => {
    const saved = { start_of_the_week: EStartOfTheWeek.MONDAY } as TUserProfile;
    const store = makeStore(() => Promise.resolve(saved));

    await expect(store.updateUserProfile({ start_of_the_week: EStartOfTheWeek.MONDAY })).resolves.toBe(saved);

    expect(store.data.start_of_the_week).toBe(EStartOfTheWeek.MONDAY);
  });
});
