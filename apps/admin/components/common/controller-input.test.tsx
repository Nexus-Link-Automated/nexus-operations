/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { INSTANCE_CONFIGURATION_MASK } from "@plane/constants";
import { ControllerInput } from "./controller-input";

type FormValues = { SECRET: string };

function Harness(props: { saved: string; required?: boolean; onSubmit: (values: FormValues) => void }) {
  const { saved, required = false, onSubmit } = props;
  const { control, handleSubmit } = useForm<FormValues>({ defaultValues: { SECRET: saved } });
  return (
    <>
      <ControllerInput
        control={control}
        type="password"
        name="SECRET"
        label="Secret"
        placeholder="Enter a secret"
        error={false}
        required={required}
      />
      <button type="button" onClick={handleSubmit(onSubmit)}>
        Submit
      </button>
    </>
  );
}

const input = () => screen.getByLabelText(/^Secret/) as HTMLInputElement;

async function submittedValue(onSubmit: ReturnType<typeof vi.fn>) {
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  return (onSubmit.mock.calls[0][0] as FormValues).SECRET;
}

describe("ControllerInput with a saved encrypted value", () => {
  it("shows that a value is saved without putting the mask in the input", () => {
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} onSubmit={vi.fn()} />);

    expect(input().value).toBe("");
    expect(input().placeholder).toBe("Keep saved value");
    expect(screen.getByText(/A value is saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();
  });

  it("submits the mask when the field is left untouched", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} onSubmit={onSubmit} />);

    expect(await submittedValue(onSubmit)).toBe(INSTANCE_CONFIGURATION_MASK);
  });

  it("submits only what was typed when replacing the value", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} onSubmit={onSubmit} />);

    await userEvent.type(input(), "new-secret");

    expect(input().value).toBe("new-secret");
    expect(await submittedValue(onSubmit)).toBe("new-secret");
  });

  it("goes back to keeping the saved value when the typed text is erased", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} onSubmit={onSubmit} />);

    await userEvent.type(input(), "typo");
    await userEvent.clear(input());

    expect(input().placeholder).toBe("Keep saved value");
    expect(await submittedValue(onSubmit)).toBe(INSTANCE_CONFIGURATION_MASK);
  });

  it("submits an empty value after choosing to remove the saved value", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Remove it" }));

    expect(screen.getByText(/will be removed when you save/)).toBeTruthy();
    expect(await submittedValue(onSubmit)).toBe("");
  });

  it("can undo a removal before saving", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(await submittedValue(onSubmit)).toBe(INSTANCE_CONFIGURATION_MASK);
  });

  it("does not offer removal for a required field, which accepts the saved value", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved={INSTANCE_CONFIGURATION_MASK} required onSubmit={onSubmit} />);

    expect(screen.queryByRole("button", { name: "Remove it" })).toBeNull();
    expect(await submittedValue(onSubmit)).toBe(INSTANCE_CONFIGURATION_MASK);
  });
});

describe("ControllerInput without a saved value", () => {
  it("behaves like a normal password field", async () => {
    render(<Harness saved="" onSubmit={vi.fn()} />);

    expect(input().placeholder).toBe("Enter a secret");
    expect(screen.queryByText(/A value is saved/)).toBeNull();
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("submits an empty value when the typed text is erased", async () => {
    const onSubmit = vi.fn();
    render(<Harness saved="" onSubmit={onSubmit} />);

    await userEvent.type(input(), "abc");
    await userEvent.clear(input());

    expect(await submittedValue(onSubmit)).toBe("");
  });
});
