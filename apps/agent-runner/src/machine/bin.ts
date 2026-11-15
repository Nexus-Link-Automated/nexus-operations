/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { main } from "./cli.ts";

// `nexus-machine`: the machine service's command line (see README, "Machine service").
const controller = new AbortController();
for (const name of ["SIGTERM", "SIGINT"] as const) {
  process.once(name, () => controller.abort());
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  signal: controller.signal,
});
// Exit now rather than wait for the kept-alive connection to close by itself.
process.exit(code);
