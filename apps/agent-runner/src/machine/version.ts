/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";

/** Set by the machine bundle's build (`tsdown.machine.config.ts`) to the package version. */
declare const __NEXUS_MACHINE_VERSION__: string | undefined;

/** From the package manifest when run from the source tree (tests, `tsx`); the bundle has its version built in. */
function sourceVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export const MACHINE_VERSION: string =
  typeof __NEXUS_MACHINE_VERSION__ === "string" ? __NEXUS_MACHINE_VERSION__ : sourceVersion();
