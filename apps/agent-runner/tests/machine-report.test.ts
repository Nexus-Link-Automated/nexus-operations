/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";

import {
  aboutMachine,
  claudeSignedIn,
  codexSignedIn,
  detectCapabilities,
  parseVersion,
  truncate,
  type DetectDeps,
} from "../src/machine/report.ts";
import { defaultCommandRunner, findOnPath } from "../src/machine/system.ts";
import { expectStrictHeartbeat, fakeFs, fakeRunner } from "./machine-helpers.ts";

const HOME = "/home/dev";
const ENV = { HOME, PATH: "/usr/bin:/home/dev/.local/bin" };

/** A typical laptop: both agents, a few toolchains, docker running. */
function laptop(): DetectDeps & { run: ReturnType<typeof fakeRunner> } {
  const bins = ["codex", "claude", "git", "node", "pnpm", "python3", "go", "java", "docker"];
  return {
    env: ENV,
    fs: fakeFs({
      executables: bins.map((bin) => (bin === "claude" ? `/home/dev/.local/bin/${bin}` : `/usr/bin/${bin}`)),
      files: {
        [`${HOME}/.codex/auth.json`]: JSON.stringify({
          OPENAI_API_KEY: null,
          tokens: { access_token: "a", refresh_token: "r" },
        }),
        [`${HOME}/.claude/.credentials.json`]: JSON.stringify({
          claudeAiOauth: { accessToken: "t", refreshToken: "r" },
        }),
      },
    }),
    run: fakeRunner({
      "codex --version": { stdout: "codex-cli 0.47.0\n" },
      "claude --version": { stdout: "2.0.14 (Claude Code)\n" },
      "git --version": { stdout: "git version 2.43.0\n" },
      "node --version": { stdout: "v24.1.0\n" },
      "pnpm --version": { stdout: "10.12.1\n" },
      "python3 --version": { stdout: "Python 3.12.3\n" },
      "go version": { stdout: "go version go1.22.1 linux/amd64\n" },
      // An old java: no `--version`; found, reported without a version.
      "java --version": { code: 1, stderr: "Unrecognized option: --version\n" },
      "docker version --format {{.Server.Version}}": { stdout: "28.1.1\n" },
    }),
  };
}

describe("machine capabilities report", () => {
  it("reports exactly the CRM's strict schema", async () => {
    const deps = laptop();
    const capabilities = await detectCapabilities(deps, 2);
    expect(capabilities).toEqual({
      agents: [
        { id: "codex", installed: true, signed_in: true, version: "0.47.0" },
        // Only the CLI's own stored sign-in: jobs cannot use it (the adapter takes a key or token).
        { id: "claude", installed: true, signed_in: false, version: "2.0.14" },
      ],
      toolchains: [
        { name: "git", version: "2.43.0" },
        { name: "node", version: "24.1.0" },
        { name: "pnpm", version: "10.12.1" },
        { name: "python3", version: "3.12.3" },
        { name: "go", version: "1.22.1" },
        { name: "java", version: "" },
      ],
      docker: { available: true, version: "28.1.1" },
      slots: { total: 2, free: 2 },
    });
    const about = aboutMachine({
      fs: deps.fs,
      hostname: () => "laptop",
      platform: "linux",
      arch: "x64",
      version: "1.5.0",
    });
    expectStrictHeartbeat({ ...about, capabilities });
    // Sign-ins are read from files and the env only.
    expect(deps.run.calls).not.toContain("codex login status");
  });

  it("reports a bare computer as having nothing, without throwing", async () => {
    const run = fakeRunner({});
    const capabilities = await detectCapabilities({ env: ENV, fs: fakeFs(), run }, 1);
    expect(capabilities).toEqual({
      agents: [
        { id: "codex", installed: false, signed_in: false, version: null },
        { id: "claude", installed: false, signed_in: false, version: null },
      ],
      toolchains: [],
      docker: { available: false, version: null },
      slots: { total: 1, free: 1 },
    });
    expect(run.calls).toEqual([]);
    expectStrictHeartbeat({ hostname: "h", os: "linux", version: "1", capabilities });
  });

  it("reports docker unavailable when its daemon does not answer", async () => {
    const run = fakeRunner({ "docker version --format {{.Server.Version}}": { code: 1, stderr: "Cannot connect" } });
    const capabilities = await detectCapabilities(
      { env: ENV, fs: fakeFs({ executables: ["/usr/bin/docker"] }), run },
      1
    );
    expect(capabilities.docker).toEqual({ available: false, version: null });
  });

  it("survives a command runner that throws", async () => {
    const deps = { ...laptop(), run: async () => Promise.reject(new Error("boom")) };
    const capabilities = await detectCapabilities(deps, 1);
    expectStrictHeartbeat({ hostname: "h", os: "linux", version: "1", capabilities });
  });

  it("clamps slots to 0..32 and keeps free equal to total", async () => {
    const deps = { env: ENV, fs: fakeFs(), run: fakeRunner({}) };
    expect((await detectCapabilities(deps, 99)).slots).toEqual({ total: 32, free: 32 });
    expect((await detectCapabilities(deps, -3)).slots).toEqual({ total: 0, free: 0 });
  });

  it("cuts long strings to the CRM's limits, counting characters like the CRM", async () => {
    const long = "x".repeat(300);
    const about = aboutMachine({
      fs: fakeFs({ files: { "/etc/os-release": `NAME=Long\nPRETTY_NAME="${"Distro ".repeat(20)}"\n` } }),
      hostname: () => long,
      platform: "linux",
      arch: "x64",
      version: "1.5.0-a-very-long-prerelease-tag-for-testing",
    });
    expect(about.hostname).toHaveLength(255);
    expect(about.os.startsWith("linux x64 Distro Distro")).toBe(true);
    expect(about.os.length).toBeLessThanOrEqual(64);
    expect(about.version.length).toBeLessThanOrEqual(32);
    // Emoji are one character to the CRM but two UTF-16 units here; never split one in half.
    expect(truncate("😀".repeat(70), 64)).toBe("😀".repeat(64));

    const run = fakeRunner({
      "git --version": { stdout: `${"nonsense ".repeat(20)}\n` },
      "codex --version": { stdout: `1.0.0-${"y".repeat(100)}\n` },
    });
    const capabilities = await detectCapabilities(
      { env: ENV, fs: fakeFs({ executables: ["/usr/bin/git", "/usr/bin/codex"] }), run },
      1
    );
    expect(capabilities.toolchains[0]?.version.length).toBe(64);
    expect(capabilities.agents[0]?.version?.length).toBe(64);
    expectStrictHeartbeat({ ...about, capabilities });
  });

  it("names the distro from os-release, or falls back to the kernel release", () => {
    const fs = fakeFs({ files: { "/etc/os-release": 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n' } });
    expect(aboutMachine({ fs, hostname: () => "h", platform: "linux", arch: "x64", version: "1" }).os).toBe(
      "linux x64 Ubuntu 24.04.1 LTS"
    );
    expect(
      aboutMachine({
        fs: fakeFs(),
        hostname: () => "h",
        platform: "linux",
        arch: "arm64",
        release: () => "6.8.0",
        version: "1",
      }).os
    ).toBe("linux arm64 6.8.0");
  });

  it("parses versions from the usual --version answers", () => {
    expect(parseVersion("rustc 1.79.0 (129f3b996 2024-06-10)", 64)).toBe("1.79.0");
    expect(parseVersion("uv 0.4.18 (7b55e9790 2024-10-01)", 64)).toBe("0.4.18");
    expect(parseVersion("8.0.100-rc.1\n", 64)).toBe("8.0.100-rc.1");
    expect(parseVersion("weird\n", 64)).toBe("weird");
    expect(parseVersion("", 64)).toBeUndefined();
  });

  it("finds commands on absolute PATH entries only", () => {
    const fs = fakeFs({ executables: ["bin/codex", "/opt/b/codex"] });
    expect(findOnPath("codex", { PATH: "bin::/opt/a:/opt/b" }, fs)).toBe("/opt/b/codex");
    expect(findOnPath("codex", {}, fs)).toBeUndefined();
  });
});

describe("agent sign-in detection", () => {
  it("codex: signed in from ~/.codex/auth.json (ChatGPT tokens or a saved API key)", async () => {
    const run = fakeRunner({});
    for (const auth of [{ tokens: { access_token: "a" } }, { OPENAI_API_KEY: "sk-test" }]) {
      const fs = fakeFs({ files: { [`${HOME}/.codex/auth.json`]: JSON.stringify(auth) } });
      // oxlint-disable-next-line no-await-in-loop -- two cases, one after the other
      expect(codexSignedIn({ env: ENV, fs, run })).toBe(true);
    }
    expect(run.calls).toEqual([]);
  });

  it("codex: honours CODEX_HOME", async () => {
    const fs = fakeFs({ files: { "/srv/codex/auth.json": JSON.stringify({ tokens: { refresh_token: "r" } }) } });
    const env = { ...ENV, CODEX_HOME: "/srv/codex" };
    expect(codexSignedIn({ env, fs, run: fakeRunner({}) })).toBe(true);
  });

  it("codex: without a usable auth file it is not signed in (a keyring sign-in cannot go into a container)", () => {
    const empty = fakeFs({
      files: { [`${HOME}/.codex/auth.json`]: JSON.stringify({ OPENAI_API_KEY: null, tokens: null }) },
    });
    const run = fakeRunner({ "codex login status": { code: 0, stdout: "Logged in using ChatGPT" } });
    expect(codexSignedIn({ env: ENV, fs: empty, run })).toBe(false);
    expect(codexSignedIn({ env: ENV, fs: fakeFs({ files: { [`${HOME}/.codex/auth.json`]: "nope" } }), run })).toBe(
      false
    );
    expect(codexSignedIn({ env: ENV, fs: fakeFs(), run })).toBe(false);
    expect(run.calls).toEqual([]);
  });

  it("codex: an OPENAI_API_KEY in the env alone is not a sign-in", async () => {
    const env = { ...ENV, OPENAI_API_KEY: "sk-test" };
    expect(codexSignedIn({ env, fs: fakeFs(), run: fakeRunner({}) })).toBe(false);
  });

  it("claude: signed in by an API key or OAuth token in the env", () => {
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(claudeSignedIn({ env: { ...ENV, [name]: "x" }, fs: fakeFs(), run: fakeRunner({}) })).toBe(true);
    }
    expect(claudeSignedIn({ env: { ...ENV, ANTHROPIC_API_KEY: "  " }, fs: fakeFs(), run: fakeRunner({}) })).toBe(false);
  });

  it("claude: the CLI's own stored sign-in does not count (jobs need a key or token in the env)", () => {
    const oauth = JSON.stringify({ claudeAiOauth: { accessToken: "t" } });
    const run = fakeRunner({});
    expect(
      claudeSignedIn({ env: ENV, fs: fakeFs({ files: { [`${HOME}/.claude/.credentials.json`]: oauth } }), run })
    ).toBe(false);
    const consoleKey = JSON.stringify({ primaryApiKey: "sk-ant-x" });
    expect(claudeSignedIn({ env: ENV, fs: fakeFs({ files: { [`${HOME}/.claude.json`]: consoleKey } }), run })).toBe(
      false
    );
    expect(claudeSignedIn({ env: ENV, fs: fakeFs(), run })).toBe(false);
  });
});

describe("the real command runner", () => {
  const env = { ...process.env };

  it("returns the exit code and output", async () => {
    const result = await defaultCommandRunner(process.execPath, ["-e", "console.log('v1.2.3'); process.exit(3)"], {
      timeoutMs: 10_000,
      env,
    });
    expect(result).toEqual({ code: 3, stdout: "v1.2.3\n", stderr: "" });
  });

  it("never throws for a missing command", async () => {
    const result = await defaultCommandRunner("/nonexistent/tool", ["--version"], { timeoutMs: 10_000, env });
    expect(result.code).toBeNull();
  });

  it("kills a command that runs past its timeout", async () => {
    const started = Date.now();
    const result = await defaultCommandRunner(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      timeoutMs: 200,
      env,
    });
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
