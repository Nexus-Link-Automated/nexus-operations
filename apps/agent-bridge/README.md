# agent-bridge

ACP (Agent Client Protocol) policy proxy for the in-app agent chat. The browser is a real ACP
client; the bridge authenticates it, then relays JSON-RPC frames to the agent runner. It enforces
policy but never translates, and it never runs agents itself (no agent CLIs or adapters in this image).

```
browser ──WS /agents/acp (cookie)──▶ agent-bridge ──WS /acp (spawn ticket)──▶ agent-runner ──stdio──▶ plane-acp-*
browser ──HTTP /agents/connections/* ─▶     │      ──HTTP /auth/* (login ticket)─▶      └──stdio──▶ plane-agent-login
                                            └─▶ API: /api/users/me/ (cookie), /api/internal/agent-sessions/,
                                                     /api/internal/agent-connections/ (shared secret)
API worker ──HTTP POST /internal/channel-sessions (shared secret)──▶ agent-bridge ──▶ (same runner path)
API        ──HTTP POST /internal/dm-turns[/…] (shared secret)──────▶      │
                                                         └─▶ API: /api/internal/chat/agent-replies/[draft/|permission/]
                                                                  (shared secret)
```

## Endpoints

- `GET /agents/acp?agent=<agent uuid>&workspace=<slug>`: WebSocket upgrade. In order:
  1. Origin check.
  2. Cookie → `/api/users/me/`.
  3. Per-user connection cap.
  4. `POST /api/internal/agent-sessions/` mints a short-lived, workspace-scoped token.
  5. Opens the runner connection.
- `GET /agents/health`: liveness, the open connection count, the running channel sessions and the held agent DM
  sessions (`dmSessions`).
- `<base>/connections/<provider>/…`: provider account sign-in (below).

When the browser disconnects (or the session ends any other way), the runner connection is closed
(the runner kills the agent) and the token is revoked with `DELETE /api/internal/agent-sessions/<id>/`.

### Ended memberships

Every `AGENT_BRIDGE_OFFBOARD_INTERVAL_MS` the bridge collects the members it holds agent state for:
those with directories on the runner (`GET /members`) and those with a chat open here. It sends them,
500 at a time, to `POST /api/internal/agent-offboarding/`, which answers whose membership has ended
(and removes any credentials and tokens still stored for them). For each of those, the bridge closes
their open chats (close code 4403) and calls the runner's `POST /members/offboard`, which stops their
agents and sign-ins and deletes their directories. A step that fails is logged and retried on the
next pass.

Before removing anything the bridge checks the API's answer. A pass that would offboard more than
`AGENT_BRIDGE_OFFBOARD_MAX_PER_PASS` members, or every member it knows about when there are two or
more, is refused and logged as an error, and nothing is removed. That is the answer an API connected
to the wrong or an empty database would give. To let a real large removal through, raise the limit
for one pass. Removing a member, a member leaving and deactivating an account also delete the member's
credentials and revoke their tokens in the API at once.

## Policy

- **Method allowlist.**
  - Browser → agent: `initialize`, `session/new|load|resume|list|close|delete|set_mode|set_config_option|prompt`,
    and the notifications `session/cancel` and `$/cancel_request`.
  - Agent → browser: `session/request_permission`, `session/update` and `$/cancel_request`.
  - Anything else gets a `-32601` answer from the bridge (requests), or is dropped (notifications, and
    responses nobody asked for). That includes `fs/*`, `terminal/*`, `authenticate`, `elicitation/*`
    and `_` extensions.
- **`initialize`**: `clientCapabilities` is forced to
  `{fs: {readTextFile: false, writeTextFile: false}, terminal: false}` (plus the browser's `session`
  capabilities).
- **`session/new|load|resume`**:
  - `cwd` is pinned to `<AGENT_WORKSPACES_ROOT>/<workspace_id>/<user_id>`.
  - `additionalDirectories` and any browser-supplied `mcpServers` are dropped.
  - Plane MCP is appended as
    `{type: "http", name: "plane", url, headers: [Authorization: Bearer <token>, X-Workspace-slug: <slug>]}`
    when the admin enabled it and the agent advertised `mcpCapabilities.http`. Otherwise the bridge
    sends a `notice` session update (or an agent message, if the browser did not advertise
    `session.notices`).
  - `_meta["plane/initialModeId"]` is the browser's request, or else the admin default, clamped to the admin maximum.
  - The result's `modes.availableModes` loses the modes above the maximum.
- **`session/list`**: `cwd` is pinned the same way.
- **`session/set_mode`** above the admin maximum, or to an unknown mode, is answered `-32602` and not forwarded.
- **Limits**:
  - The largest frame from the browser (the socket closes with 1009).
  - A per-user and a global connection cap.
  - An initialize deadline (30 s).
  - An idle timeout, which only applies when no request is in flight.
  - The connection closes when the token expires.

## Channel sessions (`POST /internal/channel-sessions`)

When someone @mentions an agent in a Nexus Messages channel, the API's worker asks the bridge to run one turn for
it. The bridge is the ACP client here (`src/channel-session.ts`), behind the same `PolicyProxy` and `SessionPolicy`
as a browser connection, so the allowlist, the pinned `cwd`, Plane MCP and the mode clamp all apply.

- **Not public.** The route is mounted at `/internal`, outside `AGENT_BRIDGE_BASE_PATH`; the reverse proxy forwards
  only the base path. It also requires `X-Agent-Bridge-Secret` (the same `AGENT_BRIDGE_SECRET`, compared in constant
  time); anything else gets 403. Every answer is `Cache-Control: no-store`.
- **Body**: `{run_id, user_id, workspace_slug, agent_id, permission_level, prompt, timeout_ms}` (`run_id` is 32 hex
  characters; `timeout_ms` 1 s to 1 h, default 5 min). 400 if it isn't valid.
- **Answer**: 202 at once, 429 when the per-user or bridge-wide connection cap is reached (channel sessions count
  against the same caps as browser chats), 503 while shutting down.
- **The session**:
  1. `POST /api/internal/agent-sessions/` mints the token for `user_id`, the person who mentioned the agent, so the
     agent's Plane MCP calls can do only what they can.
  2. The runner starts the agent at `permission_level` (the channel's), clamped to the registry maximum, in the
     spawn ticket and in `session/new`'s `_meta`.
  3. `initialize`, `session/new`, then one `session/prompt` with the API's prompt. The agent's `agent_message_chunk`
     text is the answer (up to 100,000 characters), with a blank line where a tool call came between two parts.
  4. Nobody can answer a permission prompt from a channel, so every `session/request_permission` is refused: its
     `reject_once` (or `reject_always`) option, else `cancelled`. The tool call's title is reported.
  5. The runner connection closes and the token is revoked, whatever happened.
- **The outcome** goes to `POST /api/internal/chat/agent-replies/`: `{run_id, status: "ok", text,
permission_requests}` or `{run_id, status: "failed", error}`, `error` being `timeout`, `unavailable` (runner or API
  down, or the bridge shutting down), `credentials` (the agent asked for authentication) or `failed`. Retried after
  1 s and 5 s on network errors and 5xx; a 4xx is final.
- Prompts, answers, tokens and provider env are never logged.

## Agent DM turns (`POST /internal/dm-turns`)

An agent DM in Nexus Messages is a conversation between one person and one agent. Every message the person sends
there is a turn, which the API asks the bridge for. Unlike a channel session, the bridge **holds** the DM's ACP
session between turns, and the person can answer the agent's permission prompts. Same mount, secret and
`Cache-Control: no-store` as channel sessions; the code is `src/dm-session.ts`.

- **Body**: `{run_id, channel_id, user_id, workspace_slug, agent_id, permission_level, prompt, primer, session_ref,
timeout_ms}`. `prompt` is the new message(s) only; `primer` is the DM's recent history plus them, for a session
  that starts from nothing; `session_ref` is the ACP session ID last reported for the DM (or null).
- **Answer**: 202 at once; 409 while that DM has a turn running (one at a time); 429 at the per-user or bridge-wide
  cap; 503 while shutting down; 400 if the body isn't valid.
- **The held session**:
  - Opened like a channel session (token minted for `user_id`, the DM's person; the runner starts the agent at the
    DM's level, clamped; the same `PolicyProxy` and `SessionPolicy`), then `initialize`.
  - If there is a `session_ref` and the agent advertises `loadSession`, `session/load` (whatever it replays is not the
    answer) and the turn is prompted with `prompt`. Otherwise, or if loading fails, `session/new` and `primer`.
  - The next turn of the same DM, for the same person and agent, reuses it while the token has the turn's time limit
    (plus 30 s) left; a different level is set with `session/set_mode` first.
  - It takes one per-user and one bridge-wide slot, shared with browser chats and channel sessions, from opening to
    closing. It closes (runner connection closed, token revoked, slot freed) after `AGENT_BRIDGE_DM_IDLE_TIMEOUT_MS`
    without a turn, when the token expires or the agent goes away, after a turn that didn't finish normally, and on
    shutdown.
- **A turn**:
  - The agent's `agent_message_chunk` text is the reply, as in a channel session. Its tool calls are listed by
    `toolCallId` with their title and status (pending, in_progress, completed, failed), never their input or output.
  - Drafts go to `POST /api/internal/chat/agent-replies/draft/` `{run_id, text, tool_calls}`: the first change at once,
    then at most every 500 ms, or at once when 2 KB of new text has piled up; one at a time.
  - A permission prompt goes to `POST /api/internal/chat/agent-replies/permission/` `{run_id, request_id, title,
options: [{option_id, name, kind}]}` and waits for the person's answer:
    `POST /internal/dm-turns/<channel_id>/permissions/<request_id>` `{run_id, option_id}` (204; 404 once it is no
    longer pending; 400 for an option it doesn't have). If the API won't ask (4xx), or the turn runs out of time, the
    prompt gets its reject option, else `cancelled`.
  - `POST /internal/dm-turns/<channel_id>/cancel` `{run_id}` (Stop) sends `session/cancel` and answers any waiting
    prompt `cancelled` (202; 404 if that turn isn't running).
  - A draft or prompt the API answers 404 or 409 (the agent may no longer post there) stops the turn.
  - The time limit sends `session/cancel` and ends the turn as `timeout`.
- **The outcome** goes to `POST /api/internal/chat/agent-replies/`, with the same retries as a channel session:
  `{run_id, status: "ok", text, permission_requests: [], tool_calls, session_ref, stop_reason}` (`stop_reason`
  `cancelled` after Stop) or `{run_id, status: "failed", error, text, tool_calls, session_ref}` with what was said so
  far.
- Prompts, replies, tokens and provider env are never logged.

## Provider sign-in (`<base>/connections/<provider>/…`)

Workspace settings → AI providers uses these to connect a member's own ChatGPT or Google account.
`provider` is `openai` (adapter `codex`, API method `chatgpt`) or `google` (adapter `gemini`, method
`google_account`). Every request, in order:

1. The Origin check of the WebSocket (and a GET without `Origin` whose `Sec-Fetch-Site` is
   `cross-site`/`same-site` is refused). Allowed origins get CORS headers with credentials, and
   `OPTIONS` preflights are answered (`GET, POST`, header `Content-Type`).
2. `POST` requires `Content-Type: application/json`.
3. Cookie → `/api/users/me/`.
4. `POST /api/internal/agent-connections/authorize/` `{user_id, workspace_slug}`: an active admin or member (guests cannot use agents).
5. A single-use `purpose: "login"` spawn ticket (`env: {}`, `initialMode: "ask_all"`) for the runner's
   `/auth/*` (see the runner README).

| Endpoint                                     | Body / query                 | Success                                                |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `POST …/start`                               | `{workspace}`                | 200 `{loginId, verificationUrl, userCode?, needsCode}` |
| `GET …/status?workspace=<slug>&loginId=<id>` |                              | 200 `{status, account?, error?}`                       |
| `POST …/complete`                            | `{workspace, loginId, code}` | 200 `{status, account?, error?}`                       |
| `POST …/disconnect`                          | `{workspace}`                | 204                                                    |

- `status` is `pending`, `connected` or `failed`; `account` is `{email?, plan?}` on `connected`; `error`
  is set on `failed`.
- ChatGPT (`openai`): `needsCode: false`; show `userCode` and `verificationUrl` and poll `status`.
- Google (`google`): `needsCode: true`, no `userCode`; open `verificationUrl`, then send the code the
  user pastes to `complete`.
- When `status` or `complete` reports `connected`, the bridge records the credential first:
  `PUT /api/internal/agent-connections/` `{user_id, workspace_slug, provider, method, account_label}`
  (the email). If that fails the answer is 502 and the next `status` poll retries it.
- `disconnect` signs out on the runner, then `DELETE /api/internal/agent-connections/`
  `{user_id, workspace_slug, provider}`. If the runner cannot sign out, nothing is deleted (502).
- Errors are JSON `{error}`:

| Status | Meaning                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| 400    | Unknown provider, missing/invalid `workspace`/`loginId`/`code`, not JSON, a code for a sign-in without one   |
| 401    | Not signed in                                                                                                |
| 403    | Not an active admin or member of the workspace (guests included), or a disallowed origin                     |
| 404    | Unknown sign-in (expired, or not this user's/workspace's/provider's), or an unknown route                    |
| 429    | Too many `start`s for this user (`Retry-After` is set)                                                       |
| 502    | The runner or the API is unavailable or misconfigured; or the sign-in helper failed (its message is `error`) |

- Every answer is `Cache-Control: no-store`. Cookies, tickets, verification URLs, device codes and pasted
  codes are never logged.

## Close codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 4400 | Missing or malformed `agent`/`workspace` parameters           |
| 4401 | Not signed in                                                 |
| 4403 | Not an active admin or member of the workspace                |
| 4404 | Agent not found or disabled                                   |
| 4408 | Idle timeout, or no `initialize` in time                      |
| 4410 | The agent-session token expired; reconnect and `session/load` |
| 4429 | Too many open chats (per user) or the bridge is at capacity   |
| 4502 | The agent runner is unavailable, or the agent went away       |
| 1011 | The API is unavailable or the bridge is misconfigured         |

A cross-origin upgrade is refused with HTTP 403 before any API call.

## Environment

| Variable                                | Default          | Meaning                                                                               |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `PORT` / `HOST`                         | `3400`/`0.0.0.0` | Listen address                                                                        |
| `API_BASE_URL`                          | (required)       | Plane API origin                                                                      |
| `AGENT_BRIDGE_SECRET`                   | (required)       | Same value as the API's `AGENT_BRIDGE_SECRET`                                         |
| `AGENT_RUNNER_URL`                      | (required)       | Runner endpoint, e.g. `ws://agent-runner:3410/acp`                                    |
| `AGENT_RUNNER_SECRET`                   | (required)       | Signs spawn tickets (32+ chars); same value on the runner                             |
| `AGENT_RUNNER_HTTP_URL`                 | (from the above) | Runner HTTP origin for `/auth/*`; default `AGENT_RUNNER_URL` as http(s), minus `/acp` |
| `AGENT_BRIDGE_BASE_PATH`                | `/agents`        | Mount point                                                                           |
| `AGENT_WORKSPACES_ROOT`                 | `/workspaces`    | Must equal the runner's value (the cwd is computed on both sides)                     |
| `PLANE_MCP_URL`                         | (API's value)    | Overrides the MCP URL the API returns (use the address the runner can reach)          |
| `CORS_ALLOWED_ORIGINS`                  | (empty)          | Browser origins allowed to connect (and to call `/connections`); empty: own host only |
| `AGENT_BRIDGE_MAX_MESSAGE_BYTES`        | 4 MiB            | Largest frame from the browser                                                        |
| `AGENT_BRIDGE_MAX_AGENT_MESSAGE_BYTES`  | 32 MiB           | Largest frame from the runner                                                         |
| `AGENT_BRIDGE_MAX_CONNECTIONS_PER_USER` | `4`              |                                                                                       |
| `AGENT_BRIDGE_MAX_CONNECTIONS`          | `500`            |                                                                                       |
| `AGENT_BRIDGE_IDLE_TIMEOUT_MS`          | 15 min           |                                                                                       |
| `AGENT_BRIDGE_DM_IDLE_TIMEOUT_MS`       | 10 min           | An agent DM's held session closes after this long without a turn                      |
| `AGENT_BRIDGE_PING_INTERVAL_MS`         | 30 s             | WebSocket keepalive                                                                   |
| `AGENT_BRIDGE_LOGIN_START_LIMIT`        | `10`             | Sign-in `start`s per user per window                                                  |
| `AGENT_BRIDGE_LOGIN_START_WINDOW_MS`    | 10 min           |                                                                                       |
| `AGENT_BRIDGE_OFFBOARD_INTERVAL_MS`     | 60 s             | How often ended memberships are looked for (above)                                    |
| `AGENT_BRIDGE_OFFBOARD_MAX_PER_PASS`    | `10`             | A pass that would offboard more members than this is refused (above)                  |
| `LOG_LEVEL`, `APP_VERSION`              |                  | Structured JSON logs via `@plane/logger`. Tokens, env and cookies are never logged    |

## Transports

`AgentTransport` (`src/transport.ts`) is how the bridge reaches an agent. `RunnerTransport` uses the
SDK's experimental `createWebSocketStream` with a spawn ticket. A direct remote ACP agent (the user's own
`/acp` endpoint) can be added as another implementation; the policy proxy does not change.

```sh
pnpm --filter agent-bridge test
docker build -f apps/agent-bridge/Dockerfile.agent-bridge -t plane-agent-bridge .   # BUILDX_BUILDER=default locally
```
