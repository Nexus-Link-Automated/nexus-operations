/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import { readRegularBytes, readRegularFile } from "./files.ts";

/**
 * The files a job changed, as the CRM takes them to push the job's branch (`apps/api/plane/coding/publish.py`):
 * the commit the clone started from, and each changed file's new content (base64) and mode, or that it was deleted.
 *
 * Git lists what changed, inside the container, into a file (`JobSandbox.collectChanges`); the list and the files are
 * read here, on the host, only once the container is confirmed gone, so nothing can change them while they are read.
 * Even so, nothing is trusted: the clone's folder may not be a link, every folder on a file's way must be the real
 * one under the clone, every file is opened without following links and must turn out to be under the clone, and
 * nested repositories (gitlinks) are left out.
 */

export const MAX_CHANGES_BYTES = 3 * 1024 * 1024;
export const MAX_CHANGED_FILES = 200;
/** The CRM takes a note of at most this many characters. */
export const NOTE_MAX = 300;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const GITLINK = "160000";

export type ChangeStatus = "A" | "M" | "D" | "T";

export interface ChangeEntry {
  readonly status: ChangeStatus;
  readonly path: string;
}

export type ChangedFile =
  | { readonly path: string; readonly mode: "100644" | "100755" | "120000"; readonly content: string }
  | { readonly path: string; readonly deleted: true };

export interface JobChanges {
  readonly base_commit: string;
  readonly files: readonly ChangedFile[];
}

const SHA = /^[0-9a-f]{40}$/;

export function isCommit(value: string): boolean {
  return SHA.test(value);
}

/** A path the CRM takes: relative, no empty, `.` or `..` parts, nothing under `.git`. */
export function isRepoPath(value: string): boolean {
  if (!value || value.length > 500 || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

/**
 * `git diff --raw -z --no-renames --no-abbrev` → entries, and how many nested repositories (gitlinks, mode 160000)
 * were left out. Statuses other than added, modified, deleted and type change are left out too.
 */
export function parseRawDiff(output: string): { entries: ChangeEntry[]; nested: number } {
  const parts = output.split("\0");
  const entries: ChangeEntry[] = [];
  let nested = 0;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const header = (parts[i] ?? "").replace(/^\n/, "");
    const file = parts[i + 1] ?? "";
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(header);
    if (!match || !file) continue;
    const [, oldMode, newMode, status] = match;
    if (oldMode === GITLINK || newMode === GITLINK) {
      nested += 1;
      continue;
    }
    if (status === "A" || status === "M" || status === "D" || status === "T") entries.push({ status, path: file });
  }
  return { entries, nested };
}

/** The list `collectChanges` wrote, read once the container is gone. */
export function readChangeList(file: string): { entries: ChangeEntry[]; nested: number } | { error: string } {
  const read = readRegularFile(file, MAX_LIST_BYTES);
  if (!read.ok) return read.missing ? { entries: [], nested: 0 } : { error: `the list of changes is ${read.error}` };
  return parseRawDiff(read.text);
}

function short(file: string): string {
  return file.length <= 80 ? file : `…${file.slice(-79)}`;
}

function note(text: string): { readonly ok: false; readonly note: string } {
  return { ok: false, note: text.length <= NOTE_MAX ? text : `${text.slice(0, NOTE_MAX - 1)}…` };
}

/**
 * The changes to send, or why they cannot be sent (the note goes to the CRM, which says it on the work item).
 * `repo` is the clone's folder on the host.
 */
export function readChanges(
  repo: string,
  baseCommit: string,
  entries: readonly ChangeEntry[]
): { readonly ok: true; readonly changes: JobChanges } | { readonly ok: false; readonly note: string } {
  if (!isCommit(baseCommit)) return note("the machine could not tell which commit the job started from");
  if (!entries.length) return note("the job changed no files");
  if (entries.length > MAX_CHANGED_FILES) {
    return note(`the job changed more than ${MAX_CHANGED_FILES} files, more than a pull request takes`);
  }
  // The clone's folder itself must be a real folder: the job could have swapped it for a link.
  let realRepo: string;
  try {
    const stat = lstatSync(repo);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return note("the job's clone is not a folder");
    realRepo = realpathSync(repo);
  } catch {
    return note("the job's clone is gone");
  }
  const files: ChangedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!isRepoPath(entry.path)) return note("the job changed a path a pull request cannot carry");
    if (entry.status === "D") {
      files.push({ path: entry.path, deleted: true });
      continue;
    }
    const full = path.join(repo, entry.path);
    // Every folder on the way must be the real one under the clone: no links.
    const parent = path.dirname(entry.path);
    let realParent: string;
    try {
      realParent = realpathSync(path.dirname(full));
    } catch {
      return note(`the changed file ${short(entry.path)} could not be read`);
    }
    if (realParent !== (parent === "." ? realRepo : path.join(realRepo, parent))) {
      return note(`the changed file ${short(entry.path)} is behind a symbolic link`);
    }
    let bytes: Buffer;
    let mode: "100644" | "100755" | "120000";
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        bytes = Buffer.from(readlinkSync(full), "utf8");
        mode = "120000";
      } else {
        const read = readRegularBytes(full, MAX_CHANGES_BYTES - total, realRepo);
        if (!read.ok) {
          return note(
            read.error === "too large"
              ? "the changes are larger than 3 MB, too large to send for a pull request"
              : `the changed file ${short(entry.path)} is ${read.error}`
          );
        }
        bytes = read.bytes;
        mode = read.executable ? "100755" : "100644";
      }
    } catch {
      return note(`the changed file ${short(entry.path)} could not be read`);
    }
    total += bytes.length;
    if (total > MAX_CHANGES_BYTES) return note("the changes are larger than 3 MB, too large to send");
    files.push({ path: entry.path, mode, content: bytes.toString("base64") });
  }
  return { ok: true, changes: { base_commit: baseCommit, files } };
}
