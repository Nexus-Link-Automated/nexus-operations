# agent-runner

Runs the ACP stdio adapters from `@plane/acp-adapters` (`plane-acp-claude`, `-codex`, `-deepseek`,
`-gemini`) and serves each one over ACP-on-WebSocket (the SDK's experimental `AcpServer`) to the agent
bridge. It also runs the provider sign-in helper (`plane-agent-login`) for ChatGPT and Google account
sign-ins, behind `/auth/*`.
It is a separate service from the bridge because agents need a full toolbox (shell, git, compilers,
the codex and Gemini CLIs, the Claude Agent SDK runtime), root to switch uids, and a network with only internet
egress and Plane MCP, none of which belongs next to the API.

## Protocol

- `GET /acp` (WebSocket upgrade) with `Authorization: Bearer <spawn ticket>`.
  - The ticket is `v1.<claims>.<HMAC-SHA256>`, signed with `AGENT_RUNNER_SECRET`, valid for 60 s
    and single-use. See `@plane/agent-runner-protocol`.
  - The claims are `{adapter, env, userId, workspaceId, initialMode, sessionRef, purpose}`.
    `purpose` is `acp` (or absent) for a chat; a `login` ticket is refused here with 401.
  - A missing, malformed, expired, tampered or replayed ticket gets HTTP 401. An unknown adapter
    (or `echo` when not enabled) gets 400.
- `GET /health`: `{status, version, agents, logins, isolation}`.

### Sign-in (`/auth/*`)

Provider account sign-in for Workspace settings → AI providers (ChatGPT for `codex`, Google for
`gemini`). The bridge calls these after checking the user's cookie and membership; the browser never
reaches the runner.

- Every request carries `Authorization: Bearer <ticket>` with `purpose: "login"`, `adapter` `codex`
  or `gemini`, and `env: {}`. Tickets are single-use (the same replay guard as `/acp`), so the bridge
  signs one per request. A missing, bad, replayed or `acp` ticket gets 401; another adapter gets 400.
- The helper is `node <@plane/acp-adapters>/dist/bin/login.mjs <adapter> <start|logout>`, run exactly
  like an agent: the dir's uid and dirs (prepared as for `/acp`), its own process group, `HOME` the
  user's agent home (so the adapter finds the sign-in the helper stores there), cwd the workspace dir,
  and the fixed base env only (no provider keys, nothing from the runner). It holds the uid like a
  connection does and counts against `AGENT_RUNNER_MAX_CONNECTIONS`. Its stdout carries device codes
  and is never logged.

| Endpoint                        | Body / query      | Answer                                                             |
| ------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `POST /auth/start`              |                   | `{loginId, verificationUrl, userCode?, needsCode}`                 |
| `GET /auth/status?loginId=<id>` |                   | `{status: "pending" \| "connected" \| "failed", account?, error?}` |
| `POST /auth/complete`           | `{loginId, code}` | the same state, after waiting up to 30 s for the helper            |
| `POST /auth/logout`             |                   | `{status: "disconnected"}`                                         |

- `start` waits up to 30 s for the helper's first event. One sign-in per (workspace, user, adapter):
  a new `start` stops the previous one (its status becomes `failed`). A sign-in still pending after
  15 min is killed. Finished results stay readable for 5 min.
- `status` and `complete` only see sign-ins started for the ticket's workspace, user and adapter
  (404 otherwise). `complete` is for sign-ins with `needsCode` (Google); others get 400.
- `logout` stops a sign-in in progress and runs `login.mjs <adapter> logout`.
- `account` is `{email?, plan?}`.
- Errors are `{error, reason?}`: 400 bad input, 401 ticket, 404 unknown sign-in, 409 already signed
  in, 502 the helper failed or stopped (`reason: "helper_failed"`, `error` is the helper's message),
  503 at capacity / shutting down / helper not installed, 504 the helper did not answer in time
  (`reason: "timeout"`).

### Members (`/members`)

When a workspace membership ends, the bridge removes that member's agent state here. Each request
carries its own single-use ticket; neither kind can start an agent or a sign-in, and no other kind is
accepted.

| Endpoint                 | Ticket `purpose` | Answer                                                    |
| ------------------------ | ---------------- | --------------------------------------------------------- |
| `GET /members`           | `members`        | `{members: [{workspaceId, userId}]}`: everyone with a dir |
| `POST /members/offboard` | `offboard`       | `{status: "removed"}`                                     |

- `members` tickets name no one: their adapter, user and workspace claims are ignored.
- `offboard` acts on the ticket's user in its workspace: it stops their agents and sign-ins (whatever
  the adapter), kills anything still running as their uid, and deletes their cwd, `HOME` (stored
  sign-ins included) and `TMPDIR`. Until it finishes, new agents for them get 409 and sign-ins fail.
  It is idempotent. The uid stays reserved for them, so it is never handed to anyone else.

The runner makes no access decisions: the bridge has already authenticated the user and checked
membership, and the ticket carries its word. The runner only maps the adapter to a fixed bin
(`node <@plane/acp-adapters>/dist/bin/<adapter>.mjs`), never to anything an admin or user typed.

## Isolation

Every `<workspace_id>/<user_id>` pair gets its own uid from `AGENT_RUNNER_UID_MIN..MAX`, recorded in
`<root>/.runner/uids.json`. That file is written atomically, survives restarts, and is never reset:
a damaged file is an error.

```
<root>/                     0711 root    traversable, not listable
<root>/.runner/uids.json    0700/0600    uid map
<root>/<ws>/<user>/         0700 uid     cwd, persistent across sessions
<root>/.homes/<ws>/<user>/  0700 uid     HOME (agent CLIs keep their session history here)
<root>/.tmp/<ws>/<user>/    0700 uid     TMPDIR
```

Every dir the runner chowns sits in a root-owned parent, so an agent cannot swap it for a symlink.

### Spawning

- Each agent is spawned with `uid`/`gid` set and `detached` (its own process group).
- Its env is built from nothing:
  - `PATH`, `HOME`, `TMPDIR` (and `TMP`, `TEMP`, the same dir), `USER`, `SHELL`, `LANG` and
    `PLANE_AGENT_DEFAULT_MODE`.
  - Plus the agent's env from the ticket, minus reserved names: loader and interpreter hooks
    (`LD_*`, `NODE_OPTIONS`, `BASH_ENV`, …) and the runner's own variables.
  - The adapters scrub credential-looking names again before anything the user drives sees them.

- In `uid` isolation it starts with umask 077 (`/bin/sh` sets it and execs the agent), so what it
  creates is private to its uid unless it changes the mode itself.

The sign-in helper follows the same rules.

### What agents share

The runner drops all capabilities except the few it needs to switch uids, so it cannot give each agent
its own mount or network namespace. Private temp space is what it can do: each agent's `TMPDIR`, `TMP`
and `TEMP` point at its own dir, its umask keeps new files private, and the image (with the compose
file's `/tmp` mount) makes `/tmp` and `/var/tmp` mode 1733, so agents can create files there but not
list them. Still shared between all agents in the container: the network namespace, loopback included,
`/dev/shm`, and the `/tmp` and `/var/tmp` directories themselves.

### Limits

Each agent runs under `prlimit` (which sets the limits and execs the agent, so the pid and process
group are the agent's own), with soft and hard limits both set so it cannot raise them:

- `RLIMIT_NPROC` (`AGENT_RUNNER_NPROC_LIMIT`, default 256). It counts every task the uid owns, threads
  included, across all of that workspace dir's agents, so `uid` isolation makes it per tenant.
- `RLIMIT_FSIZE` (`AGENT_RUNNER_FILE_SIZE_LIMIT_BYTES`, default 4 GiB): the largest file an agent can
  create or grow. It also caps sparse files, because growing a file past it fails with `EFBIG`.

`RLIMIT_AS` is deliberately not set: Node reserves large virtual address ranges up front and would
abort. The limits apply only in `uid` isolation; with `none` the uid is the developer's own.

The disk cap (`AGENT_RUNNER_USER_DISK_LIMIT_BYTES`, default 10 GiB, `0` is off) covers one workspace
dir: its working dir, `HOME` and `TMPDIR`, counted in allocated blocks. A connection for a dir over the
cap is refused with 507 and no agent starts. While agents run, each dir is scanned every
`AGENT_RUNNER_DISK_CHECK_INTERVAL_MS` (default 60 s), and every agent of a dir over the cap is stopped.
The scan is a `du` child process, one at a time, so it never blocks the event loop. A scan that fails
is logged and ignored; one still running after 30 s counts as over the cap.

Nothing is deleted for the user. To get a dir back under the cap, remove files from the volume by hand
or raise the limit.

### Stopping

- When the socket closes, the whole process group gets SIGTERM, then SIGKILL after
  `AGENT_RUNNER_KILL_GRACE_MS`.
- When the last connection for a uid ends, anything still running as that uid is killed.
- tini is PID 1 in the image, so orphans are reaped.

`AGENT_RUNNER_ISOLATION=none` runs agents as the runner's own user, for local development only. With
`uid` (the default) the runner refuses to start unless it is root.

### Credential broker

The scrubbing above covers the tools an agent runs, not the adapter or vendor CLI itself, which starts with the
key in its environment under the same uid as its tools (and Codex writes it to `auth.json` in that uid's home).
`AGENT_RUNNER_CREDENTIAL_BROKER=true` keeps the key out of agent uids altogether:

- The runner listens on `127.0.0.1` on an ephemeral port. For each agent it takes the API key out of the env it
  spawns, keeps it in memory only, and gives the agent an opaque token plus the proxy's URL as the vendor's
  base URL (see the adapter README for each vendor's settings).
- The proxy finds the agent by token, replaces it with the real key, and forwards to that vendor's fixed host.
  Agents share the runner's loopback, so the token alone tells them apart. Nothing in a request can choose the
  upstream. An unknown or revoked token gets 401.
- Responses stream through unbuffered, WebSocket upgrades are relayed, and redirects are returned to the client
  rather than followed. Neither requests nor their auth headers are logged. Tokens die when the agent exits,
  and any stream still open is cut.
- `AGENT_RUNNER_CREDENTIAL_BROKER` is off by default and needs a smoke test with a real key for every provider
  before it is enabled.
- With the broker off, the Claude adapter needs bubblewrap and working user namespaces to start, because it runs
  Claude Code with subprocess env scrubbing on. When the key is brokered and no other credential is in the
  agent's env, there is nothing left to scrub, so the adapter turns it off and Claude starts without them.

Not brokered, so these agents keep their credential in the environment (a warning is logged when an API key is
left behind):

- An admin env that points the vendor elsewhere: `ANTHROPIC_BASE_URL`, `ANTHROPIC_UNIX_SOCKET`,
  `GOOGLE_GEMINI_BASE_URL`, `DEEPSEEK_BASE_URL`, or a proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`), since the
  broker only talks directly to the vendor's own host.
- An agent whose env has `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` (not API keys).
- ChatGPT and Google account sign-ins, which live in the agent's home.

A key from before the flag was turned on may still sit in `~/.codex-api-key/auth.json`; Codex overwrites it with
the token at the next Codex session, so remove those files once when enabling the flag.

## Environment

| Variable                                        | Default                  | Meaning                                                      |
| ----------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `PORT` / `HOST`                                 | `3410`/`0.0.0.0`         | Listen address                                               |
| `AGENT_RUNNER_SECRET`                           | (required)               | Verifies spawn tickets (32+ chars); same value as the bridge |
| `AGENT_WORKSPACES_ROOT`                         | `/workspaces`            | The volume; must equal the bridge's value                    |
| `AGENT_RUNNER_ISOLATION`                        | `uid`                    | `uid` (needs root) or `none` (development)                   |
| `AGENT_RUNNER_UID_MIN` / `AGENT_RUNNER_UID_MAX` | `20000` / `59999`        | uid range (stays inside a 65536-uid user namespace)          |
| `AGENT_RUNNER_ENABLE_ECHO`                      | `false`                  | Allow the `echo` test agent                                  |
| `AGENT_RUNNER_AGENT_PATH`                       | node's dir + system dirs | `PATH` agents see                                            |
| `AGENT_RUNNER_AGENT_SHELL`                      | `/bin/bash`              | `SHELL` agents see                                           |
| `AGENT_RUNNER_KILL_GRACE_MS`                    | `3000`                   | SIGTERM → SIGKILL                                            |
| `AGENT_RUNNER_MAX_MESSAGE_BYTES`                | 8 MiB                    | Largest frame from the bridge                                |
| `AGENT_RUNNER_CREDENTIAL_BROKER`                | `false`                  | Keep API keys in the runner; see Credential broker           |
| `AGENT_RUNNER_MAX_CONNECTIONS`                  | `64`                     |                                                              |
| `AGENT_RUNNER_MAX_HEADER_BYTES`                 | 256 KiB                  | Tickets carry the agent env, so upgrade headers can be large |
| `AGENT_RUNNER_NPROC_LIMIT`                      | `256`                    | `RLIMIT_NPROC` for each uid (see [Limits](#limits))          |
| `AGENT_RUNNER_FILE_SIZE_LIMIT_BYTES`            | 4 GiB                    | `RLIMIT_FSIZE` for each agent                                |
| `AGENT_RUNNER_USER_DISK_LIMIT_BYTES`            | 10 GiB                   | Disk cap per workspace dir; `0` is off                       |
| `AGENT_RUNNER_DISK_CHECK_INTERVAL_MS`           | `60000`                  | How often running agents' dirs are checked                   |
| `LOG_LEVEL`, `APP_VERSION`                      |                          | Agent stderr is logged at `debug`                            |

Give the container cpu, memory and pids limits.

```sh
pnpm --filter agent-runner test     # includes the browser → bridge → runner → echo end-to-end test
docker build -f apps/agent-runner/Dockerfile.agent-runner -t plane-agent-runner .  # BUILDX_BUILDER=default locally
```
