/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main, type CliDeps } from "../src/machine/cli.ts";
import { checkCrmUrl, configDir, configPath, loadMachineConfig } from "../src/machine/config.ts";
import { EXIT_CONFIG, EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "../src/machine/service.ts";
import { FakeCrm, fakeFs, fakeRunner } from "./machine-helpers.ts";

const KEY = "nxm_secret_key_never_printed";
const CODE = "ABCD-EFGH-JKLM-NPQR";
const ABOUT = { hostname: "laptop", os: "linux x64 Test OS", version: "1.5.0" };

let crm: FakeCrm;
let home: string;
let out: string[];

function deps(extra: Partial<CliDeps> = {}): CliDeps {
  return {
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "cfg"), PATH: "/usr/bin" },
    out: (line) => out.push(line),
    err: (line) => out.push(line),
    signal: new AbortController().signal,
    run: fakeRunner({}),
    fs: fakeFs(),
    about: ABOUT,
    ...extra,
  };
}

beforeEach(async () => {
  crm = new FakeCrm();
  await crm.listen();
  home = mkdtempSync(path.join(tmpdir(), "nexus-machine-"));
  out = [];
});

afterEach(async () => {
  await crm.close();
  rmSync(home, { recursive: true, force: true });
});

describe("nexus-machine join", () => {
  it("trades the code for a key and stores it privately, never printing it", async () => {
    crm.respond = () => ({
      status: 201,
      body: {
        machine_id: "m-1",
        key: KEY,
        name: "Laptop",
        workspace_slug: "acme",
        state: "awaiting_approval",
        heartbeat_seconds: 15,
      },
    });
    const code = await main(["join", `${crm.url}/`, CODE, "--slots", "2"], deps());
    expect(code).toBe(EXIT_OK);

    expect(crm.requests).toHaveLength(1);
    const [request] = crm.requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/api/v1/coding-machines/join/");
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.body).toEqual({ code: CODE, ...ABOUT });

    const env = deps().env;
    const file = configPath(env);
    expect(file).toBe(path.join(home, "cfg", "nexus-machine", "config.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(configDir(env)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      url: crm.url,
      machineId: "m-1",
      key: KEY,
      workspaceSlug: "acme",
      name: "Laptop",
      slots: 2,
    });
    expect(out.join("\n")).not.toContain(KEY);
    expect(out.join("\n")).toContain("approve");

    // `status` shows the config, and still never the key.
    out = [];
    expect(await main(["status"], deps())).toBe(EXIT_OK);
    const printed = out.join("\n");
    expect(printed).toContain("Laptop (m-1)");
    expect(printed).toContain('"total": 2');
    expect(printed).not.toContain(KEY);
  });

  it("uses ~/.config when XDG_CONFIG_HOME is unset or relative", () => {
    expect(configPath({ HOME: "/home/dev" })).toBe("/home/dev/.config/nexus-machine/config.json");
    expect(configPath({ HOME: "/home/dev", XDG_CONFIG_HOME: "rel" })).toBe(
      "/home/dev/.config/nexus-machine/config.json"
    );
  });

  it("rejects a bad code cleanly and stores nothing", async () => {
    crm.respond = () => ({ status: 400, body: { error: "The join code is not valid.", code: "JOIN_CODE_INVALID" } });
    expect(await main(["join", crm.url, "WRONG-CODE"], deps())).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toMatch(/join code was refused/);
    expect(existsSync(configPath(deps().env))).toBe(false);
  });

  it("explains a throttled join", async () => {
    crm.respond = () => ({ status: 429, body: { detail: "throttled" }, headers: { "retry-after": "60" } });
    expect(await main(["join", crm.url, CODE], deps())).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toMatch(/too many join attempts/);
  });

  it("refuses plain http except to this computer, before sending anything", async () => {
    expect(await main(["join", "http://crm.example.com", CODE], deps())).toBe(EXIT_USAGE);
    expect(out.join("\n")).toMatch(/https/);
    expect(crm.requests).toHaveLength(0);

    expect(checkCrmUrl("http://crm.example.com")).toMatchObject({ ok: false });
    expect(checkCrmUrl("ftp://localhost")).toMatchObject({ ok: false });
    expect(checkCrmUrl("https://user:pw@crm.example.com")).toMatchObject({ ok: false });
    expect(checkCrmUrl("https://crm.example.com/?x=1")).toMatchObject({ ok: false });
    expect(checkCrmUrl("not a url")).toMatchObject({ ok: false });
    expect(checkCrmUrl("https://crm.example.com/")).toEqual({ ok: true, url: "https://crm.example.com" });
    expect(checkCrmUrl("https://crm.example.com/sub/")).toEqual({ ok: true, url: "https://crm.example.com/sub" });
    expect(checkCrmUrl("http://localhost:8000")).toEqual({ ok: true, url: "http://localhost:8000" });
    expect(checkCrmUrl("http://127.0.0.1:8000")).toEqual({ ok: true, url: "http://127.0.0.1:8000" });
    expect(checkCrmUrl("http://[::1]:8000")).toEqual({ ok: true, url: "http://[::1]:8000" });
  });

  it("refuses to overwrite an existing config unless forced", async () => {
    const file = configPath(deps().env);
    crm.respond = () => ({
      status: 201,
      body: { machine_id: "m-2", key: KEY, name: "Desk", workspace_slug: "acme", state: "awaiting_approval" },
    });
    expect(await main(["join", crm.url, CODE], deps())).toBe(EXIT_OK);
    expect(await main(["join", crm.url, CODE], deps())).toBe(EXIT_FAILURE);
    expect(crm.requests).toHaveLength(1);
    expect(await main(["join", crm.url, CODE, "--force"], deps())).toBe(EXIT_OK);
    expect(crm.requests).toHaveLength(2);
    expect(loadMachineConfig(file)).toMatchObject({ ok: true, config: { machineId: "m-2", slots: 1 } });
  });

  it("reports an unreachable CRM", async () => {
    const url = crm.url;
    await crm.close();
    expect(await main(["join", url, CODE], deps())).toBe(EXIT_FAILURE);
    expect(out.join("\n")).toMatch(/could not reach the CRM/);
  });

  it("checks usage", async () => {
    expect(await main([], deps())).toBe(EXIT_USAGE);
    expect(await main(["join", crm.url], deps())).toBe(EXIT_USAGE);
    expect(await main(["join", crm.url, CODE, "--slots", "40"], deps())).toBe(EXIT_USAGE);
    expect(await main(["join", crm.url, CODE, "--bogus"], deps())).toBe(EXIT_USAGE);
    expect(await main(["frobnicate"], deps())).toBe(EXIT_USAGE);
    expect(await main(["help"], deps())).toBe(EXIT_OK);
    expect(crm.requests).toHaveLength(0);
  });

  it("`run` without a config exits with 78 so systemd does not restart it", async () => {
    const lines: string[] = [];
    const log = { debug() {}, info() {}, warn() {}, error: (message: string) => lines.push(message) };
    expect(await main(["run"], deps({ log }))).toBe(EXIT_CONFIG);
    expect(lines.join("\n")).toMatch(/not joined/);

    // A broken config is not retried either.
    const file = configPath(deps().env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    expect(await main(["run"], deps({ log }))).toBe(EXIT_CONFIG);
  });
});
