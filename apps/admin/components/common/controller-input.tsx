/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { get } from "lodash-es";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { Controller } from "react-hook-form";
// icons
import { HideOutline, ShowOutline } from "@makeplane/propel/icons";
// plane internal packages
import { INSTANCE_CONFIGURATION_MASK } from "@plane/constants";
import { InputField } from "@makeplane/propel/components/input-field";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";

// Generic over the form's values because react-hook-form's Control is invariant: its
// `_options.validate` narrows `name` to a keyof union, so `Control<any>` no longer
// accepts a typed form's control. Inferring from `control` keeps call sites unchanged.
type Props<TFieldValues extends FieldValues = FieldValues> = {
  control: Control<TFieldValues>;
  type: "text" | "password";
  name: FieldPath<TFieldValues>;
  label: string;
  description?: string | React.ReactNode;
  placeholder: string;
  error: boolean;
  required: boolean;
};

export type TControllerInputFormField<TFieldValues extends FieldValues = FieldValues> = {
  key: FieldPath<TFieldValues>;
  type: "text" | "password";
  label: string;
  description?: string | React.ReactNode;
  placeholder: string;
  error: boolean;
  required: boolean;
};

export function ControllerInput<TFieldValues extends FieldValues = FieldValues>(props: Props<TFieldValues>) {
  const { name, control, type, label, description, placeholder, error, required } = props;
  // states
  const [showPassword, setShowPassword] = useState(false);

  return (
    <Controller
      control={control}
      name={name}
      rules={{ required: required ? `${label} is required.` : false }}
      render={({ field: { value, onChange, ref }, fieldState, formState }) => {
        // A saved encrypted value arrives as the mask. The mask stays in the form, so saving
        // without typing keeps the saved value, but it is never put in the input itself.
        const hasSavedValue = type === "password" && get(formState.defaultValues, name) === INSTANCE_CONFIGURATION_MASK;
        const isKeepingSavedValue = hasSavedValue && value === INSTANCE_CONFIGURATION_MASK;
        const isRemovingSavedValue = hasSavedValue && value === "";

        return (
          <InputField
            size="lg"
            orientation="vertical"
            id={name}
            name={name}
            type={type === "password" && showPassword ? "text" : type}
            label={label}
            required={required}
            value={isKeepingSavedValue ? "" : (value ?? "")}
            // Erasing what was typed goes back to the saved value; removing it is its own action
            onChange={(event) =>
              onChange(hasSavedValue && event.target.value === "" ? INSTANCE_CONFIGURATION_MASK : event.target.value)
            }
            ref={ref}
            error={error ? (fieldState.error?.message ?? `${label} is invalid.`) : undefined}
            hint={
              isKeepingSavedValue || isRemovingSavedValue ? (
                <>
                  {description}
                  <span className="block">
                    {isKeepingSavedValue
                      ? "A value is saved. Type a new one to replace it."
                      : "The saved value will be removed when you save."}
                    {(isRemovingSavedValue || !required) && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="text-accent-primary hover:underline"
                          onClick={() => onChange(isKeepingSavedValue ? "" : INSTANCE_CONFIGURATION_MASK)}
                        >
                          {isKeepingSavedValue ? "Remove it" : "Keep it"}
                        </button>
                      </>
                    )}
                  </span>
                </>
              ) : (
                description
              )
            }
            placeholder={isKeepingSavedValue ? "Keep saved value" : placeholder}
            endIcon={
              type === "password" && !isKeepingSavedValue ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  icon={<Icon icon={showPassword ? HideOutline : ShowOutline} />}
                  onClick={() => setShowPassword((visible) => !visible)}
                />
              ) : undefined
            }
          />
        );
      }}
    />
  );
}
