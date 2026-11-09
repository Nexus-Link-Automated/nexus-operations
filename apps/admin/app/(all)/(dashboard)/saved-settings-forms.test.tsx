/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_CONFIGURATION_MASK } from "@plane/constants";
import type { IFormattedInstanceConfiguration } from "@plane/types";
import { InstanceAIForm } from "./ai/form";
import { InstanceEmailForm } from "./email/email-config-form";
import { InstanceImageConfigForm } from "./image/form";

const updateInstanceConfigurations = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/store", () => ({ useInstance: () => ({ updateInstanceConfigurations }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: vi.fn() }));
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

beforeEach(() => {
  updateInstanceConfigurations.mockReset();
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
});
