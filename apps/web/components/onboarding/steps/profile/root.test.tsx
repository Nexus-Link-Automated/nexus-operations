/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EOnboardingSteps } from "@plane/types";

const mocks = vi.hoisted(() => ({
  isSelfManaged: false,
  updateCurrentUser: vi.fn(),
  updateUserProfile: vi.fn(),
}));

vi.mock("@/hooks/store/use-instance", () => ({
  useInstance: () => ({ config: { is_self_managed: mocks.isSelfManaged } }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({
    data: { first_name: "Ada", last_name: "Lovelace", avatar_url: "", display_name: "Ada", is_password_autoset: false },
    updateCurrentUser: mocks.updateCurrentUser,
  }),
  useUserProfile: () => ({ updateUserProfile: mocks.updateUserProfile }),
}));
vi.mock("@/services/auth.service", () => ({
  AuthService: class {
    requestCSRFToken = vi.fn();
    setPassword = vi.fn();
  },
}));
vi.mock("@/components/core/modals/user-image-upload-modal", () => ({ UserImageUploadModal: () => null }));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { ProfileSetupStep } from "./root";

const handleStepChange = vi.fn();

const submit = async () => {
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(handleStepChange).toHaveBeenCalledWith(EOnboardingSteps.PROFILE_SETUP));
};

describe("ProfileSetupStep marketing consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSelfManaged = false;
  });

  it("records nothing when the checkbox is not shown", async () => {
    mocks.isSelfManaged = true;
    render(<ProfileSetupStep handleStepChange={handleStepChange} />);

    expect(screen.queryByRole("checkbox")).toBeNull();
    await submit();

    expect(mocks.updateUserProfile).not.toHaveBeenCalled();
  });

  it("starts unchecked and records no consent if left that way", async () => {
    render(<ProfileSetupStep handleStepChange={handleStepChange} />);

    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    await submit();

    expect(mocks.updateUserProfile).toHaveBeenCalledWith({ has_marketing_email_consent: false });
  });

  it("records consent when the checkbox is ticked", async () => {
    render(<ProfileSetupStep handleStepChange={handleStepChange} />);

    fireEvent.click(screen.getByRole("checkbox"));
    await submit();

    expect(mocks.updateUserProfile).toHaveBeenCalledWith({ has_marketing_email_consent: true });
  });
});
