# Coding jobs

Press **Fix bug**, **Write test** or **Write & run test** on a work item, and a coding agent (Codex or Claude) on
your own computer does the job. When it ends, the work item gets a comment from the **Coding agent** bot, moves to
the right column, and links the pull request the job opened.

This guide is for people who use coding jobs and the admins who set them up. How it works inside is in
`apps/api/plane/coding/README.md` and `apps/agent-runner/README.md` ("Machine service").

## What each action does

| Action | Outcome | Column | The comment has |
|---|---|---|---|
| Fix bug | Fixed | In review | what was wrong and how it was fixed, the pull request |
| Fix bug | Could not fix | stays put | what was tried and why it stopped |
| Write test | Test written (not run) | Ready | the pull request |
| Write & run test | Test passes | Ready | the pull request |
| Write & run test | The product code is buggy | **Failed** | the failing test, expected vs actual, the likely cause, how to reproduce, the pull request (a draft) |
| any | Job did not finish | stays put | why, and a Retry |

**Failed** only ever means the product code has a bug. A job that breaks for any other reason (the machine went
offline, the agent crashed, the test would not compile, the time ran out, it was cancelled, the pull request could
not be opened) is "Job did not finish" and leaves the work item where it is.

## For admins: set it up once

1. **GitHub App** (instance admin, once). Create a GitHub App with repository permissions **Contents: read and
   write** and **Pull requests: read and write**, no webhook. Generate a private key. Give the server
   `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_PATH`), `GITHUB_APP_SLUG`, and optionally
   `GITHUB_APP_ALLOWED_OWNERS` (the GitHub organisations it may be used for). Install the App on the repositories
   coding jobs work on. Keep CI secrets out of workflows that run on `nexus/**` branches: those branches carry code an
   agent wrote. Without it, jobs still run, but their changes stay on the machine
   and the comment says why there is no pull request.
2. **Project settings → Coding jobs**. A workspace admin sets the repository; a project admin turns coding jobs on
   and sets the rest. Set the repository
   (`https://github.com/<owner>/<repo>`) and the branch jobs start from, and check which columns mean Ready, Failed and
   In review (matched by name unless you choose). **Create Failed column** adds one if the project has none. The page
   says whether jobs can open pull requests, and links the App's install page when it is not installed.
3. **AI provider** (optional, God mode → AI). With one set up, the CRM agent answers the coding agent's questions
   from the work item before anyone is asked.

## Your machine

Jobs run on your own computers (Linux, with Docker), never on the server, and with your own Codex or Claude sign-in.

1. **Profile settings → Machines → Add machine**. Copy the join code (shown once, valid 30 minutes).
2. On the computer, install the machine service (`install.sh` from the bundle) and run
   `nexus-machine join <CRM URL> <join code>`. Sign in to the agents there: Codex with `codex login`; Claude with
   `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the service's env file.
3. Back in **Machines**, check the hostname it reported and **Approve** it.

Each job runs in a fresh Docker container that sees only the job's folder, reaches only public internet addresses
(no LAN, no cloud metadata), and is removed when the job ends. Your home folder, SSH keys and other sign-ins are
never in it. A job never pushes: it sends its changes to the CRM, which pushes them to a branch of their own,
`nexus/<action>/<job>`, and opens the pull request. Nothing ever goes to the default branch.

## Running a job

Open a work item, choose **Coding job** → the action, the agent, and a machine (or **Auto**: any of your approved
machines that has that agent signed in). The work item's **Coding jobs** panel shows the job's progress live, the
machine it runs on, and **Cancel**. When it ends, the panel shows the outcome and the pull request; a job that did
not finish has **Retry**.

**Questions.** When the agent cannot go on without something only people know, it asks (at most 3 times). The CRM
agent answers from the work item if it can. Otherwise you get a comment on the work item, the question appears in the
work item's Messages thread (in channels linked to the project), and the job waits: answer it in the Coding jobs
panel, or reply in that thread. Any member of the project may answer; the first answer counts. With no answer in 30
minutes the agent goes on without it. Waiting does not count against the job's time limit.

## Bot members (EmployAI agents)

Workspace admins add AI agents as **bot members** (Workspace settings → Bot members): a name, a role (member or
guest) and what it is for. The bot gets an access token, shown once, for the public API and MCP; it cannot sign in to
the web app. Add it to projects and remove it like any member; removing it ends its token. A bot's coding jobs run
on **its own machines**: an admin adds a machine for it (choose the bot as the owner), runs the machine service on
the computer meant for it, and approves it. A bot never uses a person's machine or sign-in.

## Limits

- At most 10 jobs queued, running or waiting per person in a workspace, and 60 starts an hour.
- A job runs for at most 60 minutes. A job no machine takes within 24 hours ends with a note to check your machines.
- One active job per work item and action.
- Pull requests carry at most 200 changed files and 3 MB of changes; past that the changes stay on the machine.

Admins see who did what (jobs, answers, machines, settings, bot members) in the coding audit trail (API
`coding-audit/`, MCP `coding_machine` `audit`), kept a year. Progress lines are kept 30 days after a job ends.

## When something goes wrong

| You see | Do |
|---|---|
| The job stays queued | Your machine is offline, not approved, or not signed in to that agent. Check Profile → Machines. |
| "Could not clone the repository" | A private repository needs the GitHub App installed on it. |
| "No pull request: …" | The comment says why (no App, App not installed, changes too large). The changes are in `~/.local/share/nexus-machine/jobs/<job id>/changes.patch` on the machine for 7 days. |
| "Could not open the pull request: …" | The job ended as "did not finish"; fix what it says (App permissions, a branch that exists) and Retry. |
| A job error you did not expect | The machine's log: `journalctl --user -u nexus-machine`. |
