/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

import { readRegularBytes } from "./files.ts";

/**
 * The files a job changed, as the CRM takes them to push the job's branch (`apps/api/plane/coding/publish.py`):
 * the commit the clone started from, and each changed file's new content (base64) and mode, or that it was deleted.
 *
 * Git lists what changed, inside the container (`JobSandbox.collectChanges`); the files are read here, on the host,
 * only once the container is gone, so nothing can change them while they are read. Every path is checked first, no
 * folder on the way may be a symlink, and a file is read without following links, so a job cannot make this read
 * anything outside its clone.
 */

export const MAX_CHANGES_BYTES = 3 * 1024 * 1024;
export const MAX_CHANGED_FILES = 200;

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

/** `git diff --name-status -z --no-renames` → entries. Statuses other than added, modified, deleted and type change
 * (unmerged, unknown) are left out. */
export function parseNameStatus(output: string): ChangeEntry[] {
  const parts = output.split("\0");
  const entries: ChangeEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = (parts[i] ?? "").trim().charAt(0);
    const file = parts[i + 1] ?? "";
    if (!file) continue;
    if (status === "A" || status === "M" || status === "D" || status === "T") entries.push({ status, path: file });
  }
  return entries;
}

function insideWithoutLinks(repo: string, file: string): boolean {
  const parts = file.split("/");
  let current = repo;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
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
  if (!isCommit(baseCommit)) return { ok: false, note: "the machine could not tell which commit the job started from" };
  if (!entries.length) return { ok: false, note: "the job changed no files" };
  if (entries.length > MAX_CHANGED_FILES) {
    return { ok: false, note: `the job changed more than ${MAX_CHANGED_FILES} files, more than a pull request takes` };
  }
  const files: ChangedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!isRepoPath(entry.path)) return { ok: false, note: `the job changed a path a pull request cannot carry` };
    if (entry.status === "D") {
      files.push({ path: entry.path, deleted: true });
      continue;
    }
    if (!insideWithoutLinks(repo, entry.path)) {
      return { ok: false, note: `the changed file ${entry.path} is behind a symbolic link` };
    }
    const full = path.join(repo, entry.path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      return { ok: false, note: `the changed file ${entry.path} could not be read` };
    }
    let bytes: Buffer;
    let mode: "100644" | "100755" | "120000";
    if (stat.isSymbolicLink()) {
      bytes = Buffer.from(readlinkSync(full), "utf8");
      mode = "120000";
    } else {
      const read = readRegularBytes(full, MAX_CHANGES_BYTES - total);
      if (!read.ok) {
        return {
          ok: false,
          note:
            read.error === "too large"
              ? "the changes are larger than 3 MB, too large to send for a pull request"
              : `the changed file ${entry.path} is ${read.error}`,
        };
      }
      bytes = read.bytes;
      mode = read.executable ? "100755" : "100644";
    }
    total += bytes.length;
    if (total > MAX_CHANGES_BYTES) return { ok: false, note: "the changes are larger than 3 MB, too large to send" };
    files.push({ path: entry.path, mode, content: bytes.toString("base64") });
  }
  return { ok: true, changes: { base_commit: baseCommit, files } };
}
