/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The machine service as one self-contained file (`dist/machine/nexus-machine.mjs`) that
// `machine/install.sh` copies to a person's computer: every dependency is bundled, so the install
// needs only Node >= 24, not the monorepo or node_modules.
export default defineConfig({
  entry: { "nexus-machine": "src/machine/bin.ts" },
  outDir: "dist/machine",
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: false,
  noExternal: [/.*/],
  define: { __NEXUS_MACHINE_VERSION__: JSON.stringify(version) },
});
