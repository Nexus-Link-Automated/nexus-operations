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

## Machine service

`nexus-machine` runs on a person's own Linux computer (a laptop or desktop) and makes it a coding
machine for the CRM (`apps/api/plane/coding/README.md`, "Machines" and "Dispatch"). It runs as that
person and runs the coding jobs the CRM hands it, each in its own Docker container, with the
machine's own Codex and Claude sign-ins. It only connects out to the CRM over HTTPS (one kept-alive
connection) and opens no port.

The code is in `src/machine/`: `config.ts` (the saved config), `report.ts` (detection),
`client.ts` (the CRM endpoints), `service.ts` (the heartbeat loop), `jobs.ts` (the running jobs,
their progress and results), `job.ts` (one job), `sandbox.ts` (the job container), `signins.ts`,
`acp-session.ts` (the agent over ACP), `progress.ts`, `orders.ts`, `cli.ts` and `bin.ts`. The job
image is `machine/job-image/Dockerfile`.

### Install

Needs Linux, systemd, Node.js 24 or newer, and Docker (a running daemon this user may use, e.g. as a
member of the `docker` group, which is as powerful as root on that computer). As the person who will
use the machine (not root):

```sh
pnpm --filter agent-runner build:machine     # → apps/agent-runner/dist/machine/
sh apps/agent-runner/dist/machine/install.sh
```

`build:machine` needs `@plane/acp-adapters` built first (`pnpm --filter agent-runner build` does
that). `dist/machine/` holds everything an install needs (`nexus-machine.mjs` with every dependency
bundled, `install.sh`, `nexus-machine.service`, and `job-image/`: the job image's Dockerfile, the
built adapters and their dependency list), so it can be copied to another computer as is. The
installer puts:

| What                     | Where                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- |
| the bundle               | `~/.local/share/nexus-machine/nexus-machine.mjs`                                 |
| the job image's context  | `~/.local/share/nexus-machine/job-image/`                                        |
| a launcher               | `~/.local/bin/nexus-machine` (runs the bundle with the `node` it found)          |
| the systemd user unit    | `~/.config/systemd/user/nexus-machine.service` (under `$XDG_CONFIG_HOME` if set) |
| the service's env (once) | `~/.config/nexus-machine/env` (0600): your `PATH` at install time                |

A systemd user service does not get your login shell's `PATH`, so the installer saves it in the
env file, which the unit loads; that is how the service finds `codex`, `claude` and toolchains
installed under your home (nvm, `~/.cargo/bin`, ...). Edit it freely; running the installer again
upgrades the bundle and keeps it. Keys the agents should use (e.g. `ANTHROPIC_API_KEY`) can go
there too.

### Join and run

1. In the CRM, add a machine; copy its one-time join code (valid 30 minutes).
2. `nexus-machine join https://<your CRM address> <join code> [--slots N]` trades the code for the
   machine's key and saves `$XDG_CONFIG_HOME/nexus-machine/config.json` (default
   `~/.config/nexus-machine/`; dir 0700, file 0600): `{url, machineId, key, workspaceSlug, name,
slots}`. The key is never printed. Only `https://` URLs are accepted (plain `http://` only to
   `localhost`, for development). An existing config is kept unless `--force` is given. `--slots`
   (0-32, default 1) is how many jobs may run at once.
3. `systemctl --user enable --now nexus-machine` starts it now and at every login;
   `loginctl enable-linger $USER` keeps it running while you are logged out.
4. The owner approves the machine in the CRM. Until then it shows `awaiting_approval`.

`nexus-machine prepare` builds the job image now (Node 24, git and a small toolbox, the Codex CLI and
the ACP adapters; a few minutes and about 1.5 GB); otherwise `run` builds it on first start and takes
no jobs until it is ready. `nexus-machine status` shows the saved config (never the key) and the
report the machine sends.
Logs: `journalctl --user -u nexus-machine -f`. Set `NEXUS_MACHINE_DEBUG=1` (in the env file) for
every retry.

To remove it: `systemctl --user disable --now nexus-machine`, then delete the files above and
`~/.config/nexus-machine`, and remove the machine in the CRM.

### What it does while running

- Sends a heartbeat every `heartbeat_seconds` from the CRM's last answer (kept within 5 s - 5 min)
  with `Authorization: Bearer <key>` and `{hostname, os, version, capabilities}`.
- Detects capabilities at start and then every 5 minutes, not on every heartbeat (detection starts
  a process per tool). Every command runs without a shell, with stdin closed, in its own process
  group, with a 10 s timeout; a command that fails reads as absent.
- Network errors, 5xx and 429: retries after 1 s, doubling to 60 s, with jitter (each wait is
  50-100% of that); a 429's `Retry-After` is honoured up to 60 s. Back to normal after a success.
- 403 (`MACHINE_OWNER_NOT_ALLOWED`): keeps retrying every 30-60 s; it may be allowed again.
- 400 (the CRM refused the report): heartbeats go without `capabilities` until the next detection.
- 401 with `MACHINE_KEY_INVALID`, `MACHINE_UNKNOWN` or `MACHINE_REVOKED`: logs why and exits 78. A 401 without
  one of those codes (a proxy or sign-in gateway in front of the CRM, say) is retried at the slowest pace.
- SIGTERM / SIGINT: stops its jobs, tells the CRM they did not finish, and exits 0.

### How a job runs

1. A heartbeat answer hands it a job (`jobs`): the CRM's instructions, the repository and branch,
   and a time limit. Every heartbeat lists the jobs running (`running`); the CRM answers with jobs
   to stop (`cancel`: cancelled, timed out on its side, or no longer this machine's).
2. A fresh folder `~/.local/share/nexus-machine/jobs/<job id>/` (0700, `$XDG_DATA_HOME` honoured)
   with `work/`, `home/` and `out/`, and a container from the job image:
   - as your uid, `--cap-drop ALL`, `no-new-privileges`, a pids limit (`NEXUS_MACHINE_JOB_MEMORY`
     and `NEXUS_MACHINE_JOB_CPUS` add `--memory` and `--cpus`), on the machine's internal Docker
     network (see "Network" below);
   - only those three folders mounted (`/job/work`, `/job/home` as `HOME`, `/job/out`): never your
     home, SSH keys, other sign-ins, the docker socket or the machine's key.
3. The agent's sign-in, and nothing else:
   - Codex: a copy of `~/.codex/auth.json` (or `$CODEX_HOME`) in the job's home. A token Codex
     refreshes during the job is written back afterwards, only if it is still a plain file with
     Codex's own fields, for the same account (`tokens.account_id`), and your own copy did not change
     meanwhile. A sign-in kept in the OS keyring cannot be used.
   - Claude: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) from the
     env file. The Claude adapter takes only these.
   - Keys reach the agent by name through `docker exec --env NAME`, never on a command line. The
     agent can read its own sign-in inside the container; nothing else of yours is there.
4. `git clone --depth 50 --single-branch --branch <branch>` of the https repository into
   `/job/work/repo` (https only). For a private GitHub repository the order carries a read-only
   token from the CRM's GitHub App (`clone_token`, contents: read, that repository only, ended by
   GitHub after an hour): it reaches git as an extra header for the repository's host, through
   `GIT_CONFIG_*` variables passed by name to that one `git clone`, never on a command line and
   never in the clone's git config. Right after the clone, before the agent starts, the machine
   reads the commit it starts from.
5. `node /opt/nexus/acp/dist/bin/<agent>.mjs` via `docker exec -i`, driven over ACP: a session in
   the repository in `yolo` mode (nobody approves steps during a job; the container is the
   boundary) and one prompt with the CRM's instructions. Progress (messages, tools run, failures,
   the plan) goes to the CRM in batches every 3 s.
6. When the agent needs information it cannot find, it may write `{"question": "..."}` to
   `/job/out/question.json` (`NEXUS_QUESTION_FILE`) and end its turn. The machine reads it (as a
   regular file, then removes it), sends it to the CRM agent over A2A (`message/send` on the job's
   task), reads the answer back with `tasks/get` every 5 s, and gives the agent the answer the CRM
   wrote as its next prompt in the same session. The job's time limit stops while it waits. At most
   3 questions per job; a question written next to a result is not asked.
7. The agent writes its result to `/job/out/result.json` (`NEXUS_RESULT_FILE`). Inside the
   container, the machine lists what changed since the starting commit (`git diff --raw`, so
   commits the agent made count too; nested repositories are left out) and writes the changes as a
   patch (`git diff --binary`); then the container is removed (and checked to be gone: if it is
   not, nothing it wrote is read and the job ends as a job error), and only then is anything it
   wrote read: as a regular file only
   (never through a link, never a FIFO), with a size limit. The machine keeps only the fields the
   outcome allows (never `pr_url` or a branch), cuts them to the CRM's limits, adds
   `changed_files`, and sends it. No result, a broken one, a crash, a failed clone, a missing
   sign-in or the time limit become a `job_error` with the reason.
8. With an outcome that has code (`fixed`, `test_written`, `test_passed`, `bug_found`), the
   machine also sends the changed files: the starting commit and each file's new content and mode
   (or that it was deleted), read on your computer from the clone after the container is gone.
   Each path is checked (inside the repository, nothing under `.git`), the clone's folder and every
   folder on the way must be real folders under the clone (no symlinks), and a file is opened
   without following links and must turn out to be under the clone; a symlink is sent as a symlink. At most 200
   files and 3 MB in all; past that, or when a file cannot be read, the machine sends the outcome
   without the files and says why. **The CRM, not the machine, pushes them**: to the job's own
   branch (`nexus/<action>/<job>`) with its GitHub App, and opens the pull request. No token that
   can write to the repository ever reaches the machine.
9. The job's folder is removed. A job that changed code keeps only
   `jobs/<job id>/changes.patch` for 7 days and at most 20 jobs (apply it in your own clone with
   `git apply` when the pull request could not be opened). The clone itself never stays: its git
   config and hooks were written by the agent, and git on your computer would run them.

A job stays in `running` until its result is delivered; while the CRM cannot be reached the job
keeps running, progress is kept (up to 500 lines per job) and the result is retried. Progress lines
the CRM refuses (400) are dropped rather than sent again; changed files it refuses are dropped and
the outcome is sent again without them. When the CRM
ends a job, the agent gets `session/cancel` and 10 s, then its container is removed and no result is
sent. A restarted service removes containers a previous run left (they cannot be reattached), and
everything but `changes.patch` from their folders; the CRM ends those jobs as job errors. Folders a
job made read-only are made writable and removed; one that still cannot be removed is logged.

A service that stops, also because its key no longer works (exit 78), removes the containers its
jobs left and the egress proxy before it exits.

### Network

Job containers sit on an internal Docker network of this machine's (`nexus-jobs-<machine>`, made
with `--internal` and an isolated gateway: no route anywhere, and no address on this computer's
side, so not even this computer is reachable). It needs **Docker 28 or later**; on an older Docker
no job runs until it is upgraded (or egress is opened, below). Their only way out is the **egress
proxy**, a container from the job image (`machine/job-image/egress-proxy.mjs`, as `nobody`,
read-only, no capabilities, restarted with Docker, log capped at 20 MB) that is on that network as
`nexus-egress` and on Docker's default one. Each job checks the proxy before it starts. Job
containers get `HTTP_PROXY`, `HTTPS_PROXY` (and `NODE_USE_ENV_PROXY=1`), which git, curl, npm, pip,
Codex and Claude follow; tools that ignore them cannot connect at all. The proxy forwards HTTPS
(`CONNECT`) and plain HTTP only to **public IPv4 addresses** on ports **80 and 443**: it resolves
the name itself (IPv4 only), refuses private, loopback, link-local (cloud metadata), carrier-grade
NAT, multicast and other special ranges (IP literals in IPv6 form are judged the same way), and
connects to the address it checked. So a job reaches the agents' APIs, package registries and the
repository, but not your LAN or a cloud VM's metadata endpoint. One thing it does not know: if this
computer has a public IPv4 address of its own, services on it that listen on ports 80 or 443 are
reachable like any public address. Refusals are logged by the proxy (`docker logs
nexus-egress-<machine>`), at most one line a second.

- `NEXUS_MACHINE_EGRESS_PORTS=22,8443` (in the env file) allows more ports besides 80 and 443,
  still to public addresses only. Tools that ignore proxy settings cannot connect at all.
- `NEXUS_MACHINE_JOB_EGRESS=open` puts job containers back on Docker's default network, where they
  also reach your LAN and the host. Only for a machine that has nothing else on its network.

### What it reports

```json
{
  "hostname": "laptop",
  "os": "linux x64 Ubuntu 24.04.1 LTS",
  "version": "1.5.0",
  "capabilities": {
    "agents": [
      { "id": "codex", "installed": true, "signed_in": true, "version": "0.47.0" },
      { "id": "claude", "installed": true, "signed_in": false, "version": "2.0.14" }
    ],
    "toolchains": [
      { "name": "git", "version": "2.43.0" },
      { "name": "node", "version": "24.1.0" }
    ],
    "docker": { "available": true, "version": "28.1.1" },
    "slots": { "total": 1, "free": 1 }
  }
}
```

- `hostname`: `os.hostname()`; `os`: platform, arch and the distro's `PRETTY_NAME` (or the kernel
  release); `version`: this package's version. Every string is cut to the CRM's limits.
- `agents`: `installed` means the job image is ready (both agents run in it); `version` is the
  version of a CLI on this computer's `PATH`, when there is one. `signed_in` means a job can use
  the sign-in, read offline:
  - Codex: `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) holds ChatGPT tokens or a saved
    API key. A keyring sign-in, or an `OPENAI_API_KEY` in the env alone, does not count.
  - Claude: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the service's env. The Claude CLI's
    own stored sign-in does not count.
- `toolchains`: those found on `PATH` among git, gh, node, npm, pnpm, yarn, bun, deno, python3,
  uv, go, rustc, cargo, java, dotnet, ruby, php, make and gcc, with their versions (empty when the
  tool does not say).
- `docker`: available when `docker version --format '{{.Server.Version}}'` gets an answer from the
  daemon (so not when it is stopped or this user may not use it).
- `slots`: `total` from the config; `free` is `total` minus the jobs running (0 while the job image
  is not ready).

### Exit codes

| Code | Meaning                                                                  | systemd                                       |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------- |
| 0    | stopped by a signal; or a command finished                               | not restarted                                 |
| 1    | `join` failed (code refused, CRM unreachable, config not saved); a crash | `run`: restarted after 10 s                   |
| 64   | bad usage                                                                |                                               |
| 78   | not joined, a broken config, or the CRM refused the key for good (`run`) | not restarted (`RestartPreventExitStatus=78`) |

Any other failure is restarted after 10 s (`Restart=on-failure`). After a 78, join again
(`--force`) and `systemctl --user restart nexus-machine`.

The unit adds hardening that needs no user namespaces, so it works on any distro: `NoNewPrivileges`,
`LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, `SystemCallArchitectures=native` and
`UMask=0077`. It leaves out filesystem sandboxing (`ProtectHome` and similar), because jobs need
your home, your sign-ins, your toolchains and the docker socket.

```sh
pnpm --filter agent-runner exec vitest run tests/machine-*.test.ts
```

The job tests run jobs as plain processes with `tests/fixtures/fake-coding-agent.ts` (an ACP agent
on the adapters' runtime) instead of containers.
