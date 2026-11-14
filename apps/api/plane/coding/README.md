# plane.coding: coding jobs on work items

A person (or an agent using the CRM as a user) asks for **Fix bug**, **Write test** or **Write & run test** on a work
item. A coding agent (Codex or Claude) on that person's own machine does the job and reports a structured result. The
CRM, never the agent, moves the work item and writes the comment.

This app holds the job records, the per-project settings, the service that applies a result, and the endpoints.
Nothing dispatches jobs yet: they stay `queued` until a later step adds machines and dispatch.

## Layout

| Path | Contents |
|---|---|
| `models/job.py` | `CodingJob`: action, agent, requester, status, outcome, validated result, PR URL, error reason, `retry_of` |
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
| POST | `work-items/<issue_id>/coding-jobs/` `{"action", "agent"}` | members and admins |
| GET | `work-items/<issue_id>/coding-jobs/<job_id>/` | anyone who can see the work item |
| POST | `.../coding-jobs/<job_id>/cancel/` | the requester or a project admin |
| POST | `.../coding-jobs/<job_id>/retry/` `{"agent"?}` | members and admins |
| GET | `coding-settings/` | members and admins |
| PATCH | `coding-settings/` | project admins |

Errors are `{"error": ..., "code": ...}`:

| Status | Code | When |
|---|---|---|
| 400 | `CODING_NOT_CONFIGURED` | the project has coding jobs off or no repository |
| 400 | `WORK_ITEM_NOT_ELIGIBLE` | the work item is a draft, archived, or still waiting in intake |
| 409 | `JOB_ACTIVE` | the work item already has a queued, running or waiting job for that action (`job_id` names it) |
| 409 | `JOB_NOT_ACTIVE` | cancelling a job that has ended |
| 409 | `JOB_NOT_RETRYABLE` | retrying a job that was not cancelled and did not end in `job_error` |

Starting a job subscribes the requester to the work item, so the outcome comment reaches them. An id from another workspace, project or work item is a 404. A guest who cannot see a work item gets 404 for its jobs.

The MCP tool is `coding_job` (`apps/mcp/plane_mcp/tools/coding_job.py`).
