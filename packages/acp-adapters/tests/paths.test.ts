/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { PathPolicy, gateFileRead } from "../src/core/paths.ts";
import { tempDir } from "./helpers/client.ts";

let cwd: string;
let home: string;
let elsewhere: string;
let policy: PathPolicy;

const access = (target: string, glob?: string) => policy.check([{ path: target, glob }]).access;

beforeEach(() => {
  cwd = realpathSync(tempDir("paths-cwd-"));
  home = realpathSync(tempDir("paths-home-"));
  elsewhere = realpathSync(tempDir("paths-elsewhere-"));
  policy = new PathPolicy(cwd, { HOME: home });
  writeFileSync(path.join(cwd, "a.txt"), "a");
  writeFileSync(path.join(elsewhere, "b.txt"), "b");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
});

describe("paths inside and outside the working directory", () => {
  it("treats the cwd and anything under it as inside", () => {
    expect(access("a.txt")).toBe("inside");
    expect(access("")).toBe("inside");
    expect(access(".")).toBe("inside");
    expect(access(path.join(cwd, "sub/new.txt"))).toBe("inside");
    expect(access("sub/../a.txt")).toBe("inside");
  });

  it("treats anything else as outside, after resolving .. and symlinks", () => {
    expect(access("/etc/hostname")).toBe("outside");
    expect(access(path.join(elsewhere, "b.txt"))).toBe("outside");
    expect(access("../sibling")).toBe("outside");
    expect(access("sub/../../sibling")).toBe("outside");
    symlinkSync(elsewhere, path.join(cwd, "link"));
    expect(access("link/b.txt")).toBe("outside");
    expect(access("link")).toBe("outside");
  });

  it("checks a path a tool hands to the kernel without collapsing .. first", () => {
    mkdirSync(path.join(cwd, "sub"));
    symlinkSync(elsewhere, path.join(cwd, "sub/link"));
    // Lexically `sub/secret`, physically a file next to `elsewhere`.
    expect(access("sub/link/../secret")).toBe("outside");
  });

  it("follows a symlink whose target does not exist yet", () => {
    symlinkSync(path.join(elsewhere, "missing.txt"), path.join(cwd, "dangling"));
    expect(access("dangling")).toBe("outside");
  });

  it("refuses a symlink loop", () => {
    symlinkSync(path.join(cwd, "two"), path.join(cwd, "one"));
    symlinkSync(path.join(cwd, "one"), path.join(cwd, "two"));
    expect(access("one/x")).toBe("refused");
  });
});

describe("paths refused in every mode", () => {
  it("refuses /proc, however it is spelled", () => {
    expect(access("/proc/self/environ")).toBe("refused");
    expect(access("/proc/1/cmdline")).toBe("refused");
    expect(access("/proc")).toBe("refused");
    // A path through /proc that resolves somewhere ordinary still goes through /proc.
    expect(access("/proc/self/root/etc/hostname")).toBe("refused");
    expect(access("/tmp/../proc/self/environ")).toBe("refused");
    expect(access("/proc2/x")).toBe("outside");
  });

  it("refuses /proc reached through a symlink", () => {
    symlinkSync("/proc/self/environ", path.join(cwd, "env"));
    symlinkSync("/proc", path.join(cwd, "procdir"));
    expect(access("env")).toBe("refused");
    expect(access("procdir/self/environ")).toBe("refused");
  });

  it.each([
    ".codex/auth.json",
    ".codex/config.toml",
    ".codex-api-key/auth.json",
    ".gemini/oauth_creds.json",
    ".gemini/google_accounts.json",
    ".gemini/settings.json",
    ".gemini-api-key/.gemini/settings.json",
    ".claude/.credentials.json",
    ".claude/backups/.claude.json.backup.1",
    ".claude.json",
    ".claude.json.backup",
  ])("refuses ~/%s", (file) => {
    expect(access(path.join(home, file))).toBe("refused");
    expect(access(`~/${file}`)).toBe("refused");
  });

  it("leaves the CLIs' own scratch files to the outside-the-cwd rule", () => {
    for (const file of [
      ".gemini/tmp/project/tool-outputs/out.txt",
      ".gemini-api-key/.gemini/tmp/project/out.txt",
      ".claude/projects/x/tool-results/out.txt",
      ".claude/settings.json",
    ]) {
      expect(access(path.join(home, file)), file).toBe("outside");
    }
  });

  it("resolves .. and symlinks before checking", () => {
    expect(access(`${home}/x/../.codex/auth.json`)).toBe("refused");
    symlinkSync(path.join(home, ".codex"), path.join(cwd, "codex-link"));
    expect(access("codex-link/auth.json")).toBe("refused");
    symlinkSync(path.join(home, ".codex", "auth.json"), path.join(cwd, "creds"));
    expect(access("creds")).toBe("refused");
    symlinkSync(path.join(home, ".gemini", "oauth_creds.json"), path.join(cwd, "not-yet"));
    expect(access("not-yet")).toBe("refused");
  });

  it("refuses credentials even when HOME is inside the cwd", () => {
    policy = new PathPolicy(home, { HOME: home });
    expect(access(".codex/auth.json")).toBe("refused");
    expect(access("notes.txt")).toBe("inside");
  });

  it("honours a configured CODEX_HOME and CLAUDE_CONFIG_DIR", () => {
    const codexHome = path.join(elsewhere, "codex");
    const claudeDir = path.join(elsewhere, "claude");
    policy = new PathPolicy(cwd, { HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir });
    expect(access(path.join(codexHome, "auth.json"))).toBe("refused");
    expect(access(path.join(claudeDir, ".credentials.json"))).toBe("refused");
    expect(access(path.join(claudeDir, ".claude.json"))).toBe("refused");
  });

  it("recognises a symlinked HOME", () => {
    const linkedHome = path.join(elsewhere, "home-link");
    symlinkSync(home, linkedHome);
    policy = new PathPolicy(cwd, { HOME: linkedHome });
    expect(access(path.join(home, ".codex", "auth.json"))).toBe("refused");
    expect(access(`${linkedHome}/.codex/auth.json`)).toBe("refused");
  });
});

describe("glob targets", () => {
  it("starts from the part of the pattern with no wildcards", () => {
    expect(access("", "**/*.ts")).toBe("inside");
    expect(access("", "src/*.ts")).toBe("inside");
    expect(access("", "../sibling/*")).toBe("outside");
    expect(access("", "/etc/*")).toBe("outside");
    expect(access("", "/**")).toBe("outside");
    expect(access(elsewhere, "*")).toBe("outside");
  });

  it("refuses a pattern rooted at a refused directory", () => {
    expect(access("", "/proc/*/environ")).toBe("refused");
    expect(access("", "~/.codex/*")).toBe("refused");
    expect(access(home, ".codex/*")).toBe("refused");
    expect(access("", `${home}/.gemini/**`)).toBe("refused");
  });

  it("counts a directory reached through a symlink, and .. after a wildcard, as outside", () => {
    symlinkSync(elsewhere, path.join(cwd, "link"));
    expect(access("", "link/*")).toBe("outside");
    expect(access("", "*/../../sibling")).toBe("outside");
    expect(access("", "{../sibling,a}/*")).toBe("outside");
  });
});

describe("what a walk may report", () => {
  it("skips links that leave its root and anything off limits", async () => {
    symlinkSync(path.join(elsewhere, "b.txt"), path.join(cwd, "out-link"));
    symlinkSync(path.join(home, ".codex", "auth.json"), path.join(cwd, "creds"));
    const root = policy.searchRoot({ path: "" }) as string;
    expect(await policy.allowsFound(root, path.join(cwd, "a.txt"))).toBe(true);
    expect(await policy.allowsFound(root, path.join(cwd, "out-link"))).toBe(false);
    expect(await policy.allowsFound(root, path.join(cwd, "creds"))).toBe(false);
    expect(await policy.allowsFound(root, path.join(cwd, "missing"))).toBe(false);
  });

  it("reports what an approved search of an outside directory finds, but not credentials under it", async () => {
    policy = new PathPolicy(cwd, { HOME: home });
    const root = policy.searchRoot({ path: home }) as string;
    writeFileSync(path.join(home, "notes.txt"), "n");
    expect(await policy.allowsFound(root, path.join(home, "notes.txt"))).toBe(true);
    expect(await policy.allowsFound(root, path.join(home, ".codex", "auth.json"))).toBe(false);
  });
});

describe("gateFileRead", () => {
  const read = { category: "read" as const, memoryKey: "Read" };

  it("sends outside reads to the gate, remembered per path", () => {
    expect(gateFileRead(read, { access: "outside", target: "/etc/hostname" })).toEqual({
      category: "read_outside",
      memoryKey: "Read:/etc/hostname",
    });
  });

  it("leaves inside reads and other categories alone", () => {
    expect(gateFileRead(read, { access: "inside" })).toEqual(read);
    const edit = { category: "edit" as const, memoryKey: "Edit" };
    expect(gateFileRead(edit, { access: "outside", target: "/x" })).toEqual(edit);
  });
});
