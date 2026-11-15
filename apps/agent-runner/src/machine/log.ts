/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Logger } from "../logger.ts";

function format(level: string, message: string, meta?: Record<string, unknown>): string {
  return meta && Object.keys(meta).length > 0 ? `${level}: ${message} ${JSON.stringify(meta)}` : `${level}: ${message}`;
}

/**
 * A plain line logger for the machine service. Under systemd every line lands in the journal
 * (`journalctl --user -u nexus-machine`), which adds its own timestamps, so lines carry none.
 * Nothing logged may contain the machine key or a join code.
 */
export function createMachineLogger(
  options: {
    readonly debug?: boolean;
    readonly out?: (line: string) => void;
    readonly err?: (line: string) => void;
  } = {}
): Logger {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    debug: (message, meta) => {
      if (options.debug) out(format("debug", message, meta));
    },
    info: (message, meta) => out(format("info", message, meta)),
    warn: (message, meta) => err(format("warn", message, meta)),
    error: (message, meta) => err(format("error", message, meta)),
  };
}
