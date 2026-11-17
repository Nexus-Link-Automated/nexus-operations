/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from "node:fs";
import path from "node:path";

/**
 * Reading and removing what a job's container could write. The container shares the job's
 * folders with the host, so a file there may be a symlink (to anything on the host), a FIFO (whose
 * open never returns), or huge; a folder may be read-only. These helpers never follow a link,
 * never block, never read past a limit and never throw.
 */

/** The file's text when it is a regular file of at most `maxBytes`; otherwise why not. */
export function readRegularFile(
  file: string,
  maxBytes: number
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly missing: boolean; readonly error: string } {
  let fd: number;
  try {
    // O_NOFOLLOW: a symlink fails to open. O_NONBLOCK: a FIFO opens at once (and is then refused below).
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, missing, error: missing ? "missing" : "not a regular file" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, missing: false, error: "not a regular file" };
    if (stat.size > maxBytes) return { ok: false, missing: false, error: "too large" };
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return { ok: true, text: buffer.subarray(0, read).toString("utf8") };
  } catch {
    return { ok: false, missing: false, error: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/** Makes every folder under `dir` writable by its owner (never through a symlink), so it can be removed. */
function makeWritable(dir: string): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;
  try {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) makeWritable(path.join(dir, name));
  } catch {
    // Best effort; the removal below says whether it was enough.
  }
}

/** Removes `target` and everything in it, read-only folders included. Returns false when it could not. */
export function removeAll(target: string): boolean {
  try {
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    makeWritable(target);
    try {
      rmSync(target, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Drops NUL characters, which the CRM refuses in any text field. */
export function withoutNul(text: string): string {
  return text.includes("\0") ? text.replaceAll("\0", "") : text;
}
