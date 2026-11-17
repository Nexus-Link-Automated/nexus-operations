/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import http from "node:http";
import net, { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- a plain ES module shipped in the job image, without types
import { createEgressProxy, isBlockedAddress, parseTarget } from "../machine/job-image/egress-proxy.mjs";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("which addresses a job may reach", () => {
  it.each([
    ["10.1.2.3", true],
    ["172.17.0.1", true],
    ["192.168.1.10", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["100.100.100.100", true],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["::1", true],
    ["::", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:169.254.169.254", true],
    ["64:ff9b::a9fe:a9fe", true],
    ["2002:a9fe:a9fe::1", true],
    ["not-an-ip", true],
    ["1:2:3:4:5:6:7:8::9", true],
    ["140.82.112.3", false],
    ["8.8.8.8", false],
    ["2606:4700::1111", false],
    ["::ffff:140.82.112.3", false],
  ])("%s blocked: %s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it("reads CONNECT targets", () => {
    expect(parseTarget("github.com:443")).toEqual({ host: "github.com", port: 443 });
    expect(parseTarget("[2606:4700::1111]:443")).toEqual({ host: "2606:4700::1111", port: 443 });
    expect(parseTarget("github.com")).toBeNull();
    expect(parseTarget("a:99999")).toBeNull();
  });
});

describe("the egress proxy", () => {
  const PUBLIC = "140.82.112.3";

  async function proxyTo(upstreamPort: number, logs: string[]) {
    const proxy = createEgressProxy({
      resolve: async (host: string) => ({ "public.test": [PUBLIC], "inside.test": ["10.0.0.5"] })[host] ?? [],
      // The checked public address is served by a local test server.
      connect: (_port: number, address: string) =>
        net.connect({ port: address === PUBLIC ? upstreamPort : 1, host: "127.0.0.1" }),
      log: (line: string) => logs.push(line),
    });
    return listen(proxy);
  }

  function connectThrough(port: number, target: string): Promise<{ head: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      );
      socket.once("data", (chunk) => resolve({ head: chunk.toString(), socket }));
      socket.once("error", reject);
    });
  }

  it("tunnels to a public address on an allowed port", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const logs: string[] = [];
    const port = await proxyTo(await listen(echo), logs);
    const { head, socket } = await connectThrough(port, "public.test:443");
    expect(head).toMatch(/^HTTP\/1.1 200/);
    const echoed = new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(chunk.toString())));
    socket.write("hello");
    expect(await echoed).toBe("hello");
    socket.destroy();
    expect(logs).toEqual([]);
  });

  it.each([
    ["inside.test:443", "not a public address"],
    ["169.254.169.254:80", "not a public address"],
    ["public.test:22", "port 22 is not allowed"],
    ["nowhere.test:443", "not a public address"],
  ])("refuses %s", async (target, reason) => {
    const logs: string[] = [];
    const port = await proxyTo(1, logs);
    const { head, socket } = await connectThrough(port, target);
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1.1 403/);
    expect(logs.join("\n")).toContain(reason);
  });

  it("forwards plain HTTP to a public address and refuses the rest", async () => {
    const upstream = http.createServer((request, response) =>
      response.end(`got ${request.url} ${request.headers.host}`)
    );
    const logs: string[] = [];
    const port = await proxyTo(await listen(upstream), logs);
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: url, headers: { host: new URL(url).host } }, (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          })
          .on("error", reject);
      });
    expect(await get("http://public.test/index.json")).toEqual({ status: 200, body: "got /index.json public.test" });
    expect((await get("http://127.0.0.1/")).status).toBe(403);
    expect((await get("http://inside.test/")).status).toBe(403);
  });
});
