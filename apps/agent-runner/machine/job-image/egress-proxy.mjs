// Copyright (c) 2023-present Plane Software, Inc. and contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See the LICENSE file for details.
//
// The job containers' only way out (nexus-machine, src/machine/sandbox.ts). Job containers sit on an internal Docker
// network with no route anywhere; this proxy is on that network and on Docker's default one. It forwards HTTP and
// HTTPS (CONNECT) to public addresses on the allowed ports only, so a job (and an agent that work-item text steered)
// reaches the agents' APIs, package registries and the repository, but not the owner's LAN, the host, or a cloud VM's
// metadata endpoint. The name is resolved here and the connection goes to the address that was checked, so a name
// that resolves differently a moment later (DNS rebinding) changes nothing. No dependencies: it runs from the job
// image with Node alone.
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORTS = [80, 443];

const V4_BLOCKED = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Tailscale)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private (Docker's own networks too)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
];

function v4ToInt(address) {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inV4(address, [base, bits]) {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (v4ToInt(address) & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
}

function v6Words(address) {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // A trailing dotted IPv4 part.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const value = v4ToInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  // A malformed address (too many parts) gets no fill and is refused below for not having 8 words.
  const fill = tail === undefined ? [] : Array.from({ length: Math.max(0, 8 - left.length - right.length) }, () => "0");
  return [...left, ...fill, ...right].map((word) => Number.parseInt(word || "0", 16));
}

/** Whether a connection to `address` (an IP literal) must be refused. Anything that is not an IP is refused. */
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return V4_BLOCKED.some((range) => inV4(address, range));
  if (family !== 6) return true;
  const words = v6Words(address);
  if (words.length !== 8 || words.some((word) => Number.isNaN(word))) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judged as IPv4.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    const v4 = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    if (words[5] === 0xffff || words[6] !== 0 || words[7] > 1) return isBlockedAddress(v4);
    return true; // :: and ::1
  }
  const first = words[0];
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x64 && words[1] === 0xff9b) return true; // NAT64 64:ff9b::/96 (reaches IPv4 behind it)
  if (first === 0x2001 && words[1] === 0x0db8) return true; // documentation
  if (first === 0x2002) return true; // 6to4: carries an IPv4 address
  if (first === 0x2001 && words[1] === 0) return true; // Teredo
  return false;
}

/** `host:port` of a CONNECT request, or null. */
export function parseTarget(authority) {
  const match = /^\[([0-9a-fA-F:.%]+)\]:(\d{1,5})$/.exec(authority) ?? /^([^:\s/]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

/**
 * A proxy server. `resolve(host)` → addresses (IP literals); `connect(port, address)` → a socket. Both are swappable for
 * tests. `log` gets one line per refusal.
 */
export function createEgressProxy({
  ports = DEFAULT_PORTS,
  resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
  connect = (port, address) => net.connect({ port, host: address }),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const allowed = new Set(ports);

  async function pick(host, port) {
    if (!allowed.has(port)) return { error: `port ${port} is not allowed` };
    const bare = host.replace(/^\[|\]$/g, "");
    let addresses;
    try {
      addresses = net.isIP(bare) ? [bare] : await resolve(bare);
    } catch {
      return { error: `${host} does not resolve` };
    }
    const address = addresses.find((candidate) => !isBlockedAddress(candidate));
    if (!address) return { error: `${host} is not a public address` };
    return { address };
  }

  const refuse = (target, reason) => log(`egress: refused ${target}: ${reason}`);

  const server = http.createServer(async (request, response) => {
    // A plain-HTTP request through the proxy: an absolute URL.
    let url;
    try {
      url = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end("This is a proxy: send an absolute URL or CONNECT.\n");
      return;
    }
    if (url.protocol !== "http:") {
      response.writeHead(400).end("Only http:// URLs; use CONNECT for https.\n");
      return;
    }
    const port = Number(url.port || 80);
    const picked = await pick(url.hostname, port);
    if (picked.error) {
      refuse(`${url.hostname}:${port}`, picked.error);
      response.writeHead(403).end(`Refused by the job's egress proxy: ${picked.error}.\n`);
      return;
    }
    const headers = { ...request.headers, host: url.host };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        createConnection: () => connect(port, picked.address),
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      }
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  server.on("connect", async (request, client, head) => {
    client.on("error", () => client.destroy());
    const target = parseTarget(request.url ?? "");
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const picked = await pick(target.host, target.port);
    if (picked.error) {
      refuse(`${target.host}:${target.port}`, picked.error);
      client.end(`HTTP/1.1 403 Forbidden\r\n\r\nRefused by the job's egress proxy: ${picked.error}.\n`);
      return;
    }
    const upstream = connect(target.port, picked.address);
    upstream.on("error", () => {
      if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const extra = (process.env.NEXUS_EGRESS_PORTS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);
  const port = Number(process.env.NEXUS_EGRESS_LISTEN ?? 3128);
  createEgressProxy({ ports: [...DEFAULT_PORTS, ...extra] }).listen(port, "0.0.0.0", () => {
    process.stderr.write(`egress: listening on ${port}\n`);
  });
}
