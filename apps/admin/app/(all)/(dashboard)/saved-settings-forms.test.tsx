/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactElement } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_CONFIGURATION_MASK } from "@plane/constants";
import type { IFormattedInstanceConfiguration, IInstance, IInstanceAdmin } from "@plane/types";
import { useOAuthProviderConfigForm } from "@/hooks/use-oauth-provider-config-form";
import { InstanceAIForm } from "./ai/form";
import { InstanceEmailForm } from "./email/email-config-form";
import { GeneralConfigurationForm } from "./general/form";
import { InstanceImageConfigForm } from "./image/form";

const { updateInstanceConfigurations, updateInstanceInfo, setToast } = vi.hoisted(() => ({
  updateInstanceConfigurations: vi.fn(),
  updateInstanceInfo: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("@/hooks/store", () => ({ useInstance: () => ({ updateInstanceConfigurations, updateInstanceInfo }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast }));
vi.mock("./email/test-email-modal", () => ({ SendTestEmailModal: () => null }));

const config = {
  EMAIL_HOST: "smtp.example.com",
  EMAIL_PORT: "587",
  EMAIL_FROM: "team@example.com",
  EMAIL_HOST_USER: "",
  EMAIL_HOST_PASSWORD: "",
  EMAIL_USE_TLS: "1",
  EMAIL_USE_SSL: "0",
  ENABLE_SMTP: "1",
  LLM_API_KEY: "",
  LLM_MODEL: "gpt-4o-mini",
  UNSPLASH_ACCESS_KEY: "",
} as IFormattedInstanceConfiguration;

const CASES: { name: string; key: string; label: RegExp; form: () => ReactElement }[] = [
  {
    name: "email",
    key: "EMAIL_HOST_PASSWORD",
    label: /^Password/,
    form: () => <InstanceEmailForm config={config} />,
  },
  { name: "AI", key: "LLM_API_KEY", label: /^API key/, form: () => <InstanceAIForm config={config} /> },
  {
    name: "image",
    key: "UNSPLASH_ACCESS_KEY",
    label: /^Access key/,
    form: () => <InstanceImageConfigForm config={config} />,
  },
];

// what the API answers when the admin's session has ended
const SIGNED_OUT = { detail: "Authentication credentials were not provided." };

const lastToast = () => setToast.mock.calls.at(-1)?.[0] as { type: string; title: string } | undefined;

beforeEach(() => {
  updateInstanceConfigurations.mockReset();
  updateInstanceInfo.mockReset();
  setToast.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe.each(CASES)("$name settings form", ({ key, label, form }) => {
  it("shows the saved state from the API after saving a new value", async () => {
    updateInstanceConfigurations.mockResolvedValue([{ key, value: INSTANCE_CONFIGURATION_MASK }]);
    render(form());

    const field = screen.getByLabelText(label) as HTMLInputElement;
    await userEvent.type(field, "typed-value");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateInstanceConfigurations).toHaveBeenCalled());
    expect(updateInstanceConfigurations.mock.calls[0][0][key]).toBe("typed-value");
    await waitFor(() => expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText(label) as HTMLInputElement).placeholder).toBe("Keep saved value");
  });

  it.each([
    ["the save fails", { error: "Something went wrong please try again later" }, "Error"],
    ["the session has expired", SIGNED_OUT, "Session expired"],
  ])("shows an error toast when %s", async (_case, failure, title) => {
    updateInstanceConfigurations.mockRejectedValue(failure);
    render(form());

    await userEvent.type(screen.getByLabelText(label), "typed-value");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(setToast).toHaveBeenCalledTimes(1));
    expect(lastToast()).toMatchObject({ type: "error", title });
    // the typed value stays, so the admin can save again
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("typed-value");
  });
});

describe("general settings form", () => {
  const instance = { instance_name: "Acme", is_telemetry_enabled: true, instance_id: "id-1" } as IInstance;
  const admins = [{ user_detail: { email: "admin@example.com" } }] as unknown as IInstanceAdmin[];

  it.each([
    ["the save fails", { instance_name: ["This field may not be blank."] }, "Error"],
    ["the session has expired", SIGNED_OUT, "Session expired"],
  ])("shows an error toast when %s", async (_case, failure, title) => {
    updateInstanceInfo.mockRejectedValue(failure);
    render(<GeneralConfigurationForm instance={instance} instanceAdmins={admins} />);

    await userEvent.type(screen.getByLabelText(/^Name of instance/), " Inc");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(setToast).toHaveBeenCalledTimes(1));
    expect(lastToast()).toMatchObject({ type: "error", title });
  });
});

describe("OAuth provider settings forms", () => {
  it("shows an error toast when the save fails", async () => {
    updateInstanceConfigurations.mockRejectedValue({ error: "Something went wrong please try again later" });
    const { result } = renderHook(() => useOAuthProviderConfigForm("GitHub", { GITHUB_CLIENT_ID: "client-id" }));

    await act(() => result.current.onSave());

    expect(setToast).toHaveBeenCalledTimes(1);
    expect(lastToast()).toMatchObject({ type: "error", title: "Error" });
  });
});
