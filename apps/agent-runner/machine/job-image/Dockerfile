# syntax=docker/dockerfile:1.7
# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.
#
# The container each coding job runs in on a person's machine (nexus-machine, src/machine/sandbox.ts).
# Built on the machine itself, on first start or with `nexus-machine prepare`, from the folder next to
# the bundle. It holds Node, git and a small toolbox, the Codex CLI and the ACP adapters; never a
# credential (the job's sign-in copy is mounted per job). Containers run as the owner's uid, without
# capabilities, with only the job's own folders mounted.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini ca-certificates curl git ripgrep jq less procps unzip xz-utils file \
    python3 python3-pip python3-venv build-essential pkg-config \
  && rm -rf /var/lib/apt/lists/*

# The Codex CLI that plane-acp-codex starts (`codex app-server`), pinned with the adapters.
RUN npm install -g "@openai/codex@@CODEX_CLI_VERSION@" && npm cache clean --force

# The adapters' runtime dependencies at the versions the monorepo locks, then the adapters.
WORKDIR /opt/nexus/acp
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY dist ./dist
# Jobs run as the owner's uid: everything here is readable, nothing writable. pnpm and yarn via corepack.
RUN chmod -R a+rX,go-w /opt/nexus && corepack enable

WORKDIR /job/work
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
