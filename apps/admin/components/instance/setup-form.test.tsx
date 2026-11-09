/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSetupForm } from "./setup-form";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({ useSearchParams: () => search.params }));
vi.mock("@/hooks/use-csrf-token", () => ({ useCsrfToken: () => "csrf-token" }));
vi.mock("@/app/(all)/(home)/auth-header", () => ({ AuthHeader: () => null }));

const telemetryCheckbox = () => screen.getByRole("checkbox", { name: /collect usage events/ });

const submittedTelemetryValue = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[type="hidden"][name="is_telemetry_enabled"]')?.value;

beforeEach(() => {
  search.params = new URLSearchParams();
  // jsdom has no PointerEvent, which Base UI uses to forward a checkbox click to its input.
  const view = document.defaultView as Window & typeof globalThis;
  view.PointerEvent ??= view.MouseEvent as typeof PointerEvent;
});

describe("InstanceSetupForm telemetry choice", () => {
  it("starts with telemetry off", () => {
    const { container } = render(<InstanceSetupForm />);

    expect(telemetryCheckbox().getAttribute("aria-checked")).toBe("false");
    expect(submittedTelemetryValue(container)).toBe("False");
  });

  it("submits telemetry on only after the admin ticks the box", async () => {
    const { container } = render(<InstanceSetupForm />);

    await userEvent.click(telemetryCheckbox());

    expect(telemetryCheckbox().getAttribute("aria-checked")).toBe("true");
    expect(submittedTelemetryValue(container)).toBe("True");
  });

  it("keeps the admin's choice when a failed setup redirects back", () => {
    search.params = new URLSearchParams({ is_telemetry_enabled: "True" });

    const { container } = render(<InstanceSetupForm />);

    expect(submittedTelemetryValue(container)).toBe("True");
  });
});
