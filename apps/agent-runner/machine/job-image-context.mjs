// Copyright (c) 2023-present Plane Software, Inc. and contributors
// SPDX-License-Identifier: AGPL-3.0-only
// See the LICENSE file for details.
//
// Writes the job image's build context to dist/machine/job-image (part of `build:machine`): the
// Dockerfile with the pinned Codex CLI version, the built ACP adapters, and a package.json naming
// their runtime dependencies at the versions installed in this monorepo. Needs
// packages/acp-adapters to be built first.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapters = path.resolve(here, "../../../packages/acp-adapters");
const out = path.resolve(here, "../dist/machine/job-image");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
if (!existsSync(path.join(adapters, "dist/bin/codex.mjs"))) {
  console.error("job-image: build @plane/acp-adapters first (pnpm --filter @plane/acp-adapters build)");
  process.exit(1);
}
const lock = readJson(path.join(adapters, "acp-version.lock.json"));
const codexVersion = lock.providers?.["codex-cli"];
if (!/^\d+\.\d+\.\d+$/.test(codexVersion ?? "")) {
  console.error("job-image: no codex-cli version in acp-version.lock.json");
  process.exit(1);
}
const dependencies = {};
for (const name of Object.keys(readJson(path.join(adapters, "package.json")).dependencies ?? {})) {
  dependencies[name] = readJson(path.join(adapters, "node_modules", name, "package.json")).version;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(
  path.join(out, "Dockerfile"),
  readFileSync(path.join(here, "job-image/Dockerfile"), "utf8").replaceAll("@CODEX_CLI_VERSION@", codexVersion)
);
writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify({ name: "nexus-job-acp", private: true, type: "module", dependencies }, null, 2)}\n`
);
cpSync(path.join(adapters, "dist"), path.join(out, "dist"), { recursive: true });
console.log(`job-image: context written to ${path.relative(process.cwd(), out)} (codex ${codexVersion})`);
