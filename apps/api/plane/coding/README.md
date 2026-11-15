# plane.coding: coding jobs on work items

A person (or an agent using the CRM as a user) asks for **Fix bug**, **Write test** or **Write & run test** on a work
item. A coding agent (Codex or Claude) on that person's own machine does the job and reports a structured result. The
CRM, never the agent, moves the work item and writes the comment.

This app holds the job records, the per-project settings, the service that applies a result, and the endpoints.
It also holds the registry of each person's own machines. Nothing dispatches jobs yet: they stay `queued` until Step 4
adds dispatch.

## Layout

| Path | Contents |
|---|---|
| `models/job.py` | `CodingJob`: action, agent, requester, status, outcome, validated result, PR URL, error reason, `retry_of` |
| `models/machine.py` | `CodingMachine`: owner, workspace, name, state, hashed join code and key, last seen, reported capabilities |
| `machines.py` | Add, join, heartbeat, approve, revoke, remove; which machine a job may ask for |
| `models/project_settings.py` | `ProjectCodingSettings`: enabled, repo URL, default branch, the Ready / Failed / In review states |
| `columns.py` | Which state each outcome column means (the chosen state, else the state with that name, case-insensitive) |
| `outcomes.py` | `apply_result(job, result)`: validates, moves the work item, comments, finishes the job |
| `bot.py` | The per-workspace "Coding agent" bot user that authors those comments and state changes |
| `access.py` | Who may see and do what |
| `services.py` | Start, cancel, retry |
| `views/`, `urls/` | Each endpoint written once and mounted twice: public API and the web app's session routes |

## Outcomes

| Action | Outcome | Column | Comment |
|---|---|---|---|
| `fix_bug` | `fixed` | In review | PR link and a summary of the fix |
| `fix_bug` | `could_not_fix` | stays put | what was tried and why it stopped |
| `write_test` | `test_written` | Ready | PR link |
| `write_and_run_test` | `test_passed` | Ready | PR link |
| `write_and_run_test` | `bug_found` | Failed | failing test, expected vs actual, output excerpt, diagnosis, how to reproduce, PR link |
| any | `job_error` | stays put | "Job did not finish" with the reason and how to retry |

Failed means only that the product code is buggy. Cancelling a job ends it as a `job_error` with status `cancelled`.

The result schema per outcome is in `outcomes.py` (`_Fixed`, `_BugFound`, ...). Unknown fields are refused; `pr_url`
must be an https URL. Every agent-written string is escaped into the comment and output goes in code blocks; the
comment then goes through the same sanitiser and serializer as a public-API comment. The state change goes through the
public API's work item serializer and `issue_activity`, so it shows in the activity feed and the project's chat feed.
Both are attributed to the bot. Applying the same result twice changes nothing; a different result for a finished job
is refused (`RESULT_ALREADY_APPLIED`).

When the project has no state for a column, the work item stays where it is and the comment says so.

## Endpoints

Public API (personal access tokens), and the same paths under `/api/` with session auth for the web app:

| Method | Path under `/api/v1/workspaces/<slug>/projects/<project_id>/` | Who |
|---|---|---|
| GET | `work-items/<issue_id>/coding-jobs/` (`?status=`, `?action=`, cursor paging) | anyone who can see the work item |
| POST | `work-items/<issue_id>/coding-jobs/` `{"action", "agent", "machine"?}` | members and admins |
| GET | `work-items/<issue_id>/coding-jobs/<job_id>/` | anyone who can see the work item |
| POST | `.../coding-jobs/<job_id>/cancel/` | the requester or a project admin |
| POST | `.../coding-jobs/<job_id>/retry/` `{"agent"?, "machine"?}` | members and admins |
| GET | `coding-settings/` | members and admins |
| PATCH | `coding-settings/` | project admins |

`machine` is the id of one of the requester's own approved (`active`) machines in the workspace, or null for Auto. It
need not be online: the job waits in the queue. On retry, leaving `machine` out keeps the retried job's machine when it
is still one of the retrier's approved machines, else Auto. Jobs carry `machine` (null = Auto).

Errors are `{"error": ..., "code": ...}`:

| Status | Code | When |
|---|---|---|
| 400 | `CODING_NOT_CONFIGURED` | the project has coding jobs off or no repository |
| 400 | `MACHINE_NOT_AVAILABLE` | `machine` is not one of the requester's approved machines in this workspace |
| 400 | `WORK_ITEM_NOT_ELIGIBLE` | the work item is a draft, archived, or still waiting in intake |
| 409 | `JOB_ACTIVE` | the work item already has a queued, running or waiting job for that action (`job_id` names it) |
| 409 | `JOB_NOT_ACTIVE` | cancelling a job that has ended |
| 409 | `JOB_NOT_RETRYABLE` | retrying a job that was not cancelled and did not end in `job_error` |

Starting a job subscribes the requester to the work item, so the outcome comment reaches them. An id from another workspace, project or work item is a 404. A guest who cannot see a work item gets 404 for its jobs.

## Machines

A machine is one person's own computer that runs their coding jobs. It belongs to one person in one workspace, and
only that person's jobs go to it. It uses its own Codex and Claude sign-ins and only ever connects out to the CRM.

| State | Meaning | Can connect | Gets jobs (Step 4) |
|---|---|---|---|
| `pending` | added; waiting for the machine to use its join code | no | no |
| `awaiting_approval` | the machine joined and has its key; the owner has not approved it | yes | no |
| `active` | approved | yes | yes |
| `revoked` | a workspace admin cut it off; its key is refused (the machine is told it was revoked) | no | no |

1. The owner adds a machine with a name. The answer has a **join code** (`XXXX-XXXX-XXXX-XXXX`, 80 random bits) that
   works once and for 30 minutes. Only its SHA-256 is stored; it is never shown again.
2. On the machine, the machine service trades the code for its own **key** (`nxm_...`) at `join/`. Only the key's
   SHA-256 is stored. The code stops working on first use, even when it had already expired.
3. The owner checks the hostname the machine reported and approves it.
4. The machine sends a heartbeat every `heartbeat_seconds` (15) with its report. It counts as online (`is_online`)
   while the last heartbeat is at most 45 s old.

The answer that carries a join code is logged with the code redacted (`APITokenLogMiddleware`).

Removing a machine deletes its record and key hash, so the key stops working at once. Jobs that asked for it keep
`machine` null (Auto). A machine whose owner leaves the workspace or becomes a guest is refused until that changes.

People's endpoints, on the public API and the web app's routes, under `/api/v1/workspaces/<slug>/` (or `/api/...`):

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `coding-machines/` | members and admins | the caller's own machines, oldest first |
| POST | `coding-machines/` `{"name"}` | members and admins | adds one; the answer also has `join_code` (shown once) |
| GET | `coding-machines/all/` | workspace admins | every machine in the workspace |
| GET | `coding-machines/<id>/` | the owner, workspace admins | one machine |
| PATCH | `coding-machines/<id>/` `{"name"}` | the owner | renames |
| DELETE | `coding-machines/<id>/` | the owner | removes for good (204) |
| POST | `coding-machines/<id>/approve/` | the owner | `awaiting_approval` → `active` (again on `active`: no change) |
| POST | `coding-machines/<id>/revoke/` | workspace admins | → `revoked` (again: no change) |

Guests get 403 on listing, adding, renaming and approving; someone who became a guest can still read and remove a
machine they own (removing only takes access away). An in-app agent's session token cannot add or approve a machine
(403 `AGENT_SESSION_NOT_ALLOWED`): those are the owner's own check of which computers get their jobs. Revoking cuts off
one machine, not the person: to stop someone having machines, make them a guest or remove them from the workspace. Another person's machine is 404 to a member; to an admin it is readable and revocable,
and any other action is 403. Names are 1 to 80 characters. A person has at most 20 machines per workspace
(409 `MACHINE_LIMIT`). Approving a machine that has not joined is 409 `MACHINE_NOT_JOINED`; a revoked one, 409
`MACHINE_REVOKED`.

A machine reads as:

```json
{"id", "workspace", "owner", "owner_display_name", "name", "state", "is_online", "last_seen_at", "hostname", "os",
 "version", "capabilities", "join_code_expires_at", "join_code_expired", "joined_at", "approved_at", "revoked_at",
 "revoked_by", "created_at", "updated_at"}
```

The machine's own endpoints are on the public API only and take no personal token or cookie:

| Method | Path | Auth | Body | Answer |
|---|---|---|---|---|
| POST | `/api/v1/coding-machines/join/` | the join code in the body | `{"code", "hostname"?, "os"?, "version"?}` | 201 `{"machine_id", "key", "name", "workspace_slug", "state", "heartbeat_seconds"}` |
| POST | `/api/v1/coding-machines/heartbeat/` | `Authorization: Bearer <key>` | `{"hostname"?, "os"?, "version"?, "capabilities"?}` | 200 `{"machine_id", "name", "state", "heartbeat_seconds", "jobs": []}` |

`capabilities` (every field required when sent; unknown fields refused):

```json
{
  "agents": [{"id": "codex" | "claude", "installed": true, "signed_in": true, "version": "0.47.0"}],
  "toolchains": [{"name": "node", "version": "24.1.0"}],
  "docker": {"available": true, "version": "28.1.1"},
  "slots": {"total": 2, "free": 2}
}
```

At most 2 agents and 30 toolchains; strings are bounded; `slots` 0 to 32 and `free <= total`.

| Status | Code | Meaning for the machine |
|---|---|---|
| 400 | `JOIN_CODE_INVALID` | the code is wrong, used, expired, or its owner can no longer have machines |
| 401 | `MACHINE_KEY_INVALID`, `MACHINE_UNKNOWN`, `MACHINE_REVOKED` | the key will never work again: stop |
| 403 | `MACHINE_OWNER_NOT_ALLOWED` | the owner left the workspace or became a guest: retry slowly |
| 429 | | too many requests (join: 30 per hour per address; heartbeat: 720 per hour per key) |

The connection is a heartbeat over one kept-alive HTTPS connection rather than a socket held open: the API runs
Django request handlers, where a held request would tie up a worker. Step 4 hands out jobs in the heartbeat answer
(`jobs`), or adds a socket if it needs lower latency.

The MCP tools are `coding_job` and `coding_machine` (`apps/mcp/plane_mcp/tools/`).
