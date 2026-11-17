# plane.coding: coding jobs on work items

A person (or an agent using the CRM as a user) asks for **Fix bug**, **Write test** or **Write & run test** on a work
item. A coding agent (Codex or Claude) on that person's own machine does the job and reports a structured result. The
CRM, never the agent, moves the work item and writes the comment.

This app holds the job records, the per-project settings, the service that applies a result, and the endpoints.
It also holds the registry of each person's own machines and hands queued jobs to them (`dispatch.py`).

## Layout

| Path | Contents |
|---|---|
| `models/job.py` | `CodingJob`: action, agent, requester, status, outcome, validated result, PR URL, error reason, `retry_of` |
| `models/machine.py` | `CodingMachine`: owner, workspace, name, state, hashed join code and key, last seen, reported capabilities |
| `machines.py` | Add, join, heartbeat, approve, revoke, remove; which machine a job may ask for |
| `dispatch.py` | Handing queued jobs to machines in heartbeats, progress lines, results from machines, ending jobs whose machine went quiet |
| `instructions.py` | The prompt the CRM writes for a job, with the work item's text fenced as data |
| `github.py` | The CRM's GitHub App: short-lived installation tokens for one repository |
| `a2a.py` | The CRM agent's A2A endpoint: each job is a task; the coding agent's questions arrive here |
| `questions.py` | Who answers a coding agent's question: the CRM agent from the work item, else a person |
| `models/question.py` | `CodingJobQuestion`: a question, its answer and who gave it |
| `bot_members.py`, `models/bot_member.py` | EmployAI agents as bot members: create, role, token, removal |
| `audit.py`, `models/audit.py`, `views/audit.py` | The coding audit trail |
| `retention.py` | How long progress lines and audit events are kept |
| `publish.py` | Pushing a job's changes to its own branch and opening the pull request |
| `models/changes.py` | `CodingJobChanges`: a finished job's changed files while the CRM pushes them |
| `models/event.py` | `CodingJobEvent`: a progress line a machine reported |
| `tasks.py` | `expire_coding_jobs`, every minute from Celery beat |
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

The result schema per outcome is in `outcomes.py` (`_Fixed`, `_BugFound`, ...). Unknown fields are refused, `pr_url`
and the branch included: the CRM opens the pull request itself and adds its link (see "Pull requests"). A job that
changed code also reports `changed_files` (added by the machine, not the agent). Every agent-written string is escaped into the comment and output goes in code blocks; the
comment then goes through the same sanitiser and serializer as a public-API comment. The state change goes through the
public API's work item serializer and `issue_activity`, so it shows in the activity feed and the project's chat feed.
Both are attributed to the bot. Applying the same result twice changes nothing; a different result for a finished job
is refused (`RESULT_ALREADY_APPLIED`).

When the project has no state for a column, the work item stays where it is and the comment says so.

A work item archived (or turned back into a draft or intake item) while its job runs is not moved: the outcome is
recorded and commented, and the comment says it was not moved. A work item deleted mid-job gets no comment; the job
still ends with its outcome. A queued job whose work item was archived or deleted, whose project turned coding jobs
off, or whose requester can no longer run jobs in the project ends as a job error when a machine would have taken it.

## Pull requests

The CRM, never the machine, pushes a job's changes and opens its pull request, with its own GitHub App
(`github.py`). The App's id and private key are server settings only:

| Setting | Meaning |
|---|---|
| `GITHUB_APP_ID` | The App's id |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` | Its private key (PEM; `\n` in the variable is read as a newline) |
| `GITHUB_APP_SLUG` | Its name in its URL, for the install link the settings show |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | `https://api.github.com` and `https://github.com` unless GitHub Enterprise |

The App needs these repository permissions: **Contents: read and write**, **Pull requests: read and write**
(Metadata: read comes with them). Install it on the repositories whose projects run coding jobs. The project's
`repo_url` must be `https://github.com/<owner>/<repo>`.

For each job the CRM asks GitHub for an installation token limited to the project's one repository and to exactly
the permissions needed; GitHub ends it after an hour, and the CRM never stores it:

- **Push** (contents: write, pull requests: write), used by the CRM only. The machine sends the files the job changed
  with its result (`changes`). The CRM keeps them (`CodingJobChanges`) while a task (`publish_coding_job`) makes a
  commit of them on the job's starting commit (GitHub's Git Data API: no git on the server), creates the branch
  `nexus/<action>/<first 8 hex of the job id>` (created, never updated, so an existing branch, the default branch
  included, is never moved; a name that is the default branch is refused before anything is sent), and opens a pull
  request into the project's default branch. A `bug_found` pull request carries the failing test and is a draft. Its
  title is the work item's key and title; everything a coding agent wrote goes in a fenced code block. Then the
  outcome is applied with `pr_url` and `pr_branch`, and the changes are deleted.
- **Clone** (contents: read), only for a private repository: in the job's order as `clone_token`.

Until the pull request is open the job stays `running` with `result_received_at` set: the machine is done with it,
it frees the machine's slot, and a silent machine does not end it. A push or pull request that fails (or is not
open after 15 minutes) ends the job as a `job_error` with the reason, never Failed; the changes stay in the job's
folder on the machine. A job whose project's repository is not on GitHub, or whose CRM has no App or no installation
on the repository, has its outcome applied at once, and the comment says why there is no pull request.

`GET .../coding-settings/repository/` (members and admins) says whether the project's jobs can open pull requests:

```json
{"repo_url", "provider": "github" | null, "app_configured", "install_url", "installed", "private",
 "repo_default_branch", "pull_requests", "reason"}
```

## Questions (A2A)

A coding agent that cannot go on without information may ask, at most 3 times per job and one at a time: it writes
`{"question": "..."}` to the file named by `NEXUS_QUESTION_FILE` and ends its turn. The machine sends the question
to the CRM agent over [A2A](https://a2a-protocol.org) and gives the agent the answer as its next prompt, in the same
session.

The CRM hosts the A2A endpoint, `POST /api/v1/coding-machines/a2a/` (JSON-RPC 2.0, the machine's key as bearer; the
agent card is at `GET /api/v1/coding-machines/a2a/agent-card/`). Each job is a task: `id` is the job's id,
`contextId` its work item's. `message/send` with the question (role `user`, a text part, `taskId`) makes the job
`needs_input` (task state `input-required`); `tasks/get` returns the task with its history, where each answer has
role `agent` and `metadata` `{"answered_by": "crm_agent" | "person" | "nobody", "name", "question_message_id",
"prompt"}`; `prompt` is what the machine gives the agent, written by the CRM. `tasks/cancel` is refused: people cancel
jobs in the CRM. Errors are JSON-RPC errors (`-32001` task not found, `-32002` not cancelable, `-32600` with
`data.code` `QUESTION_OPEN`, `QUESTION_LIMIT` or `JOB_NOT_ACTIVE`).

Who answers:

1. The CRM agent, first: the instance's AI provider (God mode → AI: `LLM_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`)
   reads the work item, fenced as data, and answers only when the work item clearly does. Without a provider this
   step is skipped.
2. Otherwise a person. The bot comments the question on the work item (which notifies its subscribers, the
   requester among them), and it is posted in the work item's Messages thread in every channel linked to the
   project. Any member of the project answers, the first answer counting: in the coding jobs panel, with
   `POST .../coding-jobs/<job_id>/answer/` `{"text"}` (MCP `coding_job` `answer`), or by replying in that thread.
   A reply from someone who is not a member of the project is just a message.
3. Nobody, after `CODING_QUESTION_TIMEOUT_MINUTES` (30): the agent is told to go on without an answer.

The job's deadline does not run while it waits: when the question is answered (or not), `deadline_at` moves on by
the time it waited, and the machine stops its own clock meanwhile. In Messages, the question and its answers show
their text only to readers who can see the work item; the stored body (searched and exported) says only that a coding
job asked something. Jobs carry their `questions` (`seq`, `question`, `status`: `thinking`, `waiting`, `answered`,
`unanswered`; `answer`, `answered_by`, `answered_by_agent`, `answered_by_name`, `asked_at`, `answered_at`).

## Bot members (EmployAI agents)

An EmployAI agent is a bot member of a workspace: a `User` with `is_bot` and `bot_type` `EMPLOYAI`, a workspace role
(member or guest, never admin) and its own access token, scoped to the workspace. It cannot sign in to the web app;
it uses the CRM only through the public API and MCP, like any member: project admins add it to projects, its role is
changed and it is removed from the workspace's members list like anyone (Plane's member endpoints treat EmployAI bots
as members, `plane.utils.bot_members`), and removing it ends its tokens. The web app shows it with a bot badge.

Workspace admins (people, not bots, and not an in-app agent's session) manage them, under
`/api/v1/workspaces/<slug>/bot-members/` (and the web app's `/api/...`); MCP tool `bot_member`:

| Method | Path | Does |
|---|---|---|
| GET | `bot-members/` | the workspace's bot members, removed ones included |
| POST | `bot-members/` `{"name", "role"?: 15 \| 5, "description"?}` | creates one; the answer has `token`, shown once (at most 20 per workspace) |
| GET, PATCH | `bot-members/<id>/` `{"name"?, "role"?, "description"?}` | reads or changes it (a guest's project roles become guest) |
| DELETE | `bot-members/<id>/` | removes it, as removing any member does |
| POST | `bot-members/<id>/token/` | a new token, shown once; every earlier one stops working |

A bot member reads as `{"id", "name", "display_name", "description", "role", "is_active", "created_by", "created_at",
"token_created_at", "token_last_used"}`. The token in an answer is not kept in the API request log.

**Its coding jobs run on its own machines** (decided 2026-11-17), never on a person's or with a person's sign-ins.
A workspace admin adds a machine for it (`POST coding-machines/` with `"owner": <bot id>`; the bot must be a member,
not a guest), runs the machine service on the computer meant for it with that join code, and approves it; renaming
and removing it are an admin's too. The bot itself cannot add, approve, rename or remove machines
(`BOT_NOT_ALLOWED`). Its jobs then go to its machines exactly as a person's go to theirs. Machines read with
`owner_is_bot`.

## Limits, audit and retention

| Setting | Default | Meaning |
|---|---|---|
| `CODING_MAX_ACTIVE_JOBS_PER_USER` | 10 | jobs one person (or bot) may have queued, running or waiting in a workspace; more is 429 `JOB_LIMIT` |
| `CODING_JOB_STARTS_PER_HOUR` | 60 | starts and retries per person per hour (429) |
| `CODING_JOB_QUEUE_TTL_HOURS` | 24 | a job no machine took in this long ends as a job error saying so |
| `CODING_JOB_TIMEOUT_MINUTES` | 60 | how long a job runs (not counting time waiting for an answer) |
| `CODING_QUESTION_TIMEOUT_MINUTES` | 30 | how long a question waits for an answer |
| `CODING_JOB_EVENT_RETENTION_DAYS` | 30 | progress lines of a job are deleted this long after it ended |
| `CODING_AUDIT_RETENTION_DAYS` | 365 | audit events are deleted after this long |

A machine runs at most its slots (1 to 32) at once. `purge_coding_history` runs daily (04:40 UTC); jobs, results,
questions and answers stay with the work item.

The **audit trail** records, with who did it (a person, a bot member, `machine <name>`, the CRM agent or the CRM):
`job.started`, `job.retried`, `job.cancelled`, `job.handed_out`, `job.finished` (outcome, pull request or reason),
`question.asked`, `question.answered`, `question.unanswered`, `machine.added`, `machine.joined`, `machine.approved`,
`machine.renamed`, `machine.removed`, `machine.revoked`, `settings.changed`, `bot.created`, `bot.updated`,
`bot.token_replaced`, `bot.removed`. Workspace admins read it with `GET /api/v1/workspaces/<slug>/coding-audit/`
(`?action=job` or `job.started`, `?actor=`, `?project=`, `?target=`, `?before=` from `next_before`; 100 per page,
newest first) or MCP `coding_machine` `audit`.

Planted instructions in work-item text are handled in layers: the CRM writes every prompt and fences work-item text
(and answers) as data; agents run in a container with only the job's folders and no credentials but their own
sign-in; they reach only public addresses on ports 80 and 443; they cannot push, and the CRM pushes only to the job's
own branch; nothing they report is trusted (results are validated and escaped, `pr_url` and branches are the CRM's).

## Endpoints

Public API (personal access tokens), and the same paths under `/api/` with session auth for the web app:

| Method | Path under `/api/v1/workspaces/<slug>/projects/<project_id>/` | Who |
|---|---|---|
| GET | `work-items/<issue_id>/coding-jobs/` (`?status=`, `?action=`, cursor paging) | anyone who can see the work item |
| POST | `work-items/<issue_id>/coding-jobs/` `{"action", "agent", "machine"?}` | members and admins |
| GET | `work-items/<issue_id>/coding-jobs/<job_id>/` | anyone who can see the work item |
| GET | `.../coding-jobs/<job_id>/events/` (`?after=<seq>`) | anyone who can see the work item |
| POST | `.../coding-jobs/<job_id>/cancel/` | the requester or a project admin |
| POST | `.../coding-jobs/<job_id>/retry/` `{"agent"?, "machine"?}` | members and admins |
| POST | `.../coding-jobs/<job_id>/answer/` `{"text"}` | members and admins |
| GET | `coding-settings/` | members and admins |
| PATCH | `coding-settings/` | project admins |

`machine` is the id of one of the requester's own approved (`active`) machines in the workspace, or null for Auto. It
need not be online: the job waits in the queue. On retry, leaving `machine` out keeps the retried job's machine when it
is still one of the retrier's approved machines, else Auto. Jobs carry `machine` (null = Auto), and once a machine took
them `ran_on` and `ran_on_name` (kept after the machine is removed), the latest `progress` line and `progress_at`, and
`deadline_at`.

`events/` answers `{"results": [{"seq", "kind", "text", "created_at"}], "has_more"}`: up to 200 progress lines after
`after`, oldest first. `kind` is `status`, `message`, `tool` or `plan`; `text` is plain text written by a coding agent.
A job keeps its latest 500.

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

| State | Meaning | Can connect | Gets jobs |
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

Removing a machine deletes its record and key hash, so the key stops working at once. Queued jobs that asked for it
keep `machine` null (Auto); revoking it ends them as job errors instead, since it will never take them. A machine whose owner leaves the workspace or becomes a guest is refused until that changes.

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
| POST | `/api/v1/coding-machines/heartbeat/` | `Authorization: Bearer <key>` | `{"hostname"?, "os"?, "version"?, "capabilities"?, "running"?}` | 200 `{"machine_id", "name", "state", "heartbeat_seconds", "jobs", "cancel"}` |
| POST | `/api/v1/coding-machines/jobs/events/` | the key | `{"jobs": [{"id", "events": [{"kind", "text"}]}]}` | 200 `{"ended": [job ids]}` |
| POST | `/api/v1/coding-machines/jobs/<job_id>/result/` | the key | `{"result": {...}, "changes"?, "changes_note"?}` | 200 `{"job_id", "status", "outcome", "changed"}` |

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
| 429 | | too many requests (join: 30 per hour per address; heartbeat: 720, events: 1800, results: 360 per hour per key) |

The connection is a heartbeat over one kept-alive HTTPS connection rather than a socket held open: the API runs
Django request handlers, where a held request would tie up a worker. A job therefore starts within one heartbeat
(15 s) of being queued.

## Dispatch

`running` lists the jobs the machine is running (at most 32). A machine that leaves it out gets no jobs. On each
heartbeat, in one transaction, the machine and its owner's workspace membership are read again under lock (a revoke,
removal or demotion that landed after the key was checked wins: 401 or 403, and nothing is handed out), then:

1. Its running jobs are matched with `running`. A job the CRM gave it that it does not list is offered again in `jobs`
   for 60 s if the machine never confirmed it (the answer may have been lost), else it ends as a job error ("did not
   start", or "stopped running the job unexpectedly" once confirmed). A listed job the CRM has ended (cancelled, timed
   out) or never gave it is in `cancel`: the machine stops it.
2. If the machine is `active`, it gets the oldest queued jobs of its owner in this workspace that asked for it, or for
   Auto, and whose agent it reports installed and signed in; at most its free slots (the reported `free`, and never
   more than `total` minus the jobs the CRM has running on it). Two machines asking at once never get the same job
   (`SKIP LOCKED`). Each becomes `running` with `started_at`, `ran_on`, `ran_on_name` and `deadline_at`.

Each entry in `jobs`:

```json
{"id", "action", "agent", "repo_url", "branch", "work_item": {"id", "identifier", "name", "url"},
 "instructions", "timeout_seconds"}
```

A private GitHub repository's order also has `clone_token` (see "Pull requests").

`changes` on a result is `{"base_commit": "<40 hex>", "files": [{"path", "mode": "100644" | "100755" | "120000",
"content": "<base64>"} | {"path", "deleted": true}]}`: at most 200 files and 3 MB of content, paths inside the
repository and not under `.git`. `changes_note` (at most 300 characters) says why a job with changed files sends none.

`instructions` is the whole prompt (`instructions.py`): the task for the action, the rules (work only in the clone, no
commits or pushes; how to ask a question), the work item's title, description and latest 10 human comments between two lines of a
random marker, stated to be data and not instructions, and the result format. The agent writes its result as one JSON
object to the file named by `NEXUS_RESULT_FILE`; the machine sends it to `result/`, where `outcomes.apply_result`
validates and applies it. The same result again answers `changed: false`; a different one, or one for a job that has
ended, is 409; a job that is not this machine's is 404; an invalid result is 400 `INVALID_RESULT`.

`events/` stores progress lines for running jobs; `ended` names the batch's jobs that are no longer running on the
machine. A job runs for at most `CODING_JOB_TIMEOUT_MINUTES` (60); the machine stops it then and reports a job error.
`expire_coding_jobs` (every minute) ends, as job errors, running jobs whose machine sent no heartbeat for 3 minutes,
was revoked or removed, or that are 2 minutes past their deadline.

The MCP tools are `coding_job` and `coding_machine` (`apps/mcp/plane_mcp/tools/`).
