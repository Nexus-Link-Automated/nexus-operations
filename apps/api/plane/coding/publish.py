# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Pushing a job's changes to a branch of its own and opening the pull request: done by the CRM, never the machine.

The machine sends the files the job changed with its result (`CodingJobChanges`). The CRM then, with a token for the
project's one repository that it asks GitHub for right then (`github.repo_token`) and never hands out:

1. makes a commit of those files on top of the commit the job's clone started from (blobs, a tree on the starting
   commit's tree, a commit with that commit as its parent: GitHub's Git Data API, so no git runs on the server);
2. creates the job's branch, `nexus/<action>/<first 8 hex of the job id>`, pointing at it. The branch name comes from
   the job, never from the agent or the machine. The ref is created, never updated, so an existing branch, the
   default branch included, is never moved; and a name that is the default branch is refused before anything is sent;
3. opens a pull request from that branch into the project's default branch. Its title and body come from the work
   item and the outcome; everything an agent or a person wrote goes in a fenced code block, so it cannot mention
   people or add links or images. A `bug_found` pull request (it carries the failing test) is a draft.

Then the outcome is applied with the pull request's link (`outcomes.apply_result(pr_url=...)`). When any of that fails,
the job ends as a job error with the reason (never Failed: Failed means only that the product code is buggy), and the
changes stay in the job's folder on the machine.
"""

import base64
import logging
from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone

from plane.coding import github
from plane.coding.exceptions import Conflict, InvalidResult
from plane.coding.github import GitHubError, Repo
from plane.coding.models import CodingAction, CodingJob, CodingJobChanges, JobOutcome, ProjectCodingSettings
from plane.coding.outcomes import CODE_OUTCOMES, apply_result
from plane.utils.host import base_host

logger = logging.getLogger("plane.coding")

__all__ = [
    "BRANCH_PREFIX",
    "CODE_OUTCOMES",
    "PublishError",
    "branch_name",
    "check_branch",
    "no_pr_reason",
    "publish_job",
    "pull_request_body",
    "pull_request_title",
    "repository_access",
]

BRANCH_PREFIX = "nexus/"
TITLE_MAX = 200
BODY_MAX = 60_000
FENCED_MAX = 20_000


class PublishError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def branch_name(job: CodingJob) -> str:
    """The job's branch: from its action and id only."""
    return f"{BRANCH_PREFIX}{job.action.replace('_', '-')}/{job.id.hex[:8]}"


def check_branch(branch: str, default_branches) -> None:
    """Refuses any branch but a job branch, and the default branch whatever it is called."""
    defaults = {name.strip().lower() for name in default_branches if name}
    if not branch.startswith(BRANCH_PREFIX) or branch.lower() in defaults or ".." in branch:
        raise PublishError(f"Refused to push to {branch}: jobs push only to a branch of their own.")


def no_pr_reason(project_id) -> str | None:
    """Why a job in this project cannot open a pull request, or None when it can try."""
    coding_settings = ProjectCodingSettings.objects.filter(project_id=project_id).first()
    repo = github.parse_repo(coding_settings.repo_url) if coding_settings else None
    if repo is None:
        return "the project's repository is not on GitHub, so jobs cannot open pull requests for it"
    if not github.app_configured():
        return "this CRM has no GitHub App set up for opening pull requests"
    if not github.owner_allowed(repo):
        return f"this CRM's GitHub App is not allowed for {repo.owner}'s repositories"
    try:
        if github.installation_id(repo) is None:
            return f"the CRM's GitHub App is not installed on {repo.full_name}"
    except GitHubError:
        # Not knowable now: try, and end as a job error with GitHub's reason if it fails.
        return None
    return None


def repository_access(project_id) -> dict:
    """Whether jobs in this project can open pull requests, and why not: for the project's coding settings."""
    coding_settings = ProjectCodingSettings.objects.filter(project_id=project_id).first()
    repo_url = coding_settings.repo_url if coding_settings else ""
    answer = {
        "repo_url": repo_url,
        "provider": None,
        "app_configured": github.app_configured(),
        "install_url": github.install_url(),
        "installed": None,
        "private": None,
        "repo_default_branch": None,
        "pull_requests": False,
        "reason": None,
    }
    repo = github.parse_repo(repo_url)
    if repo is None:
        answer["reason"] = (
            "No repository is set."
            if not repo_url
            else "The repository is not on GitHub: jobs cannot open pull requests."
        )
        return answer
    answer["provider"] = "github"
    if not answer["app_configured"]:
        answer["reason"] = "This CRM has no GitHub App set up: ask the instance admin."
        return answer
    if not github.owner_allowed(repo):
        answer["reason"] = f"This CRM's GitHub App is not allowed for {repo.owner}'s repositories."
        return answer
    try:
        installation = github.installation_id(repo)
        answer["installed"] = installation is not None
        if installation is None:
            answer["reason"] = f"The CRM's GitHub App is not installed on {repo.full_name}."
            return answer
        info = github.repo_info(repo, github.repo_token(repo, github.CLONE_PERMISSIONS))
    except GitHubError as error:
        answer["reason"] = error.message
        return answer
    answer.update(private=info["private"], repo_default_branch=info["default_branch"], pull_requests=True)
    if coding_settings and info["default_branch"] and info["default_branch"] != coding_settings.default_branch:
        answer["reason"] = (
            f"Jobs start from {coding_settings.default_branch} and open pull requests into it, but the repository's "
            f"default branch is {info['default_branch']}."
        )
    return answer


# --------------------------------------------------------------------------- pull request text


def _fence(text: str) -> str:
    """`text` in a fenced block no line of it can close: GitHub renders no mentions, links or images there."""
    text = text if len(text) <= FENCED_MAX else text[:FENCED_MAX] + "\n[cut]"
    longest, run = 0, 0
    for char in text:
        run = run + 1 if char == "`" else 0
        longest = max(longest, run)
    fence = "`" * max(3, longest + 1)
    return f"{fence}text\n{text}\n{fence}"


_OUTCOME_LINES = {
    JobOutcome.FIXED: "Fixed: the agent changed the product code.",
    JobOutcome.TEST_WRITTEN: "Test written (not run).",
    JobOutcome.TEST_PASSED: "Test written and run: it passes.",
    JobOutcome.BUG_FOUND: "Test written and run: it fails because the product code is buggy. This pull request "
    "carries the failing test.",
}


def _identifier(job: CodingJob) -> str:
    return f"{job.issue.project.identifier}-{job.issue.sequence_id}"


def pull_request_title(job: CodingJob, outcome: str) -> str:
    action = {
        CodingAction.FIX_BUG: "Fix",
        CodingAction.WRITE_TEST: "Test",
        CodingAction.WRITE_AND_RUN_TEST: "Failing test" if outcome == JobOutcome.BUG_FOUND else "Test",
    }[CodingAction(job.action)]
    # A title is plain text on GitHub; newlines and control characters are dropped.
    name = " ".join("".join(ch if ch.isprintable() else " " for ch in job.issue.name).split())
    title = f"{_identifier(job)} {action}: {name}"
    return title if len(title) <= TITLE_MAX else title[: TITLE_MAX - 1] + "…"


def _reported(data: dict) -> str:
    lines = []
    if data.get("test_name"):
        lines.append(f"Test: {data['test_name']}")
    if data.get("summary"):
        lines.append(data["summary"])
    if data.get("outcome") == JobOutcome.BUG_FOUND:
        diagnosis = data.get("diagnosis") or {}
        lines += [
            "Expected:",
            data.get("expected", ""),
            "Actual:",
            data.get("actual", ""),
            f"Likely cause: {diagnosis.get('likely_cause', '')}",
        ]
        if diagnosis.get("file"):
            location = diagnosis["file"] + (f":{diagnosis['line']}" if diagnosis.get("line") else "")
            lines.append(f"Where: {location}")
        lines += ["Reproduce with:", data.get("reproduce", "")]
    return "\n".join(lines)


def pull_request_body(job: CodingJob, data: dict) -> str:
    url = f"{base_host(request=None, is_app=True).rstrip('/')}/{job.workspace.slug}/browse/{_identifier(job)}/"
    parts = [
        f"Opened by a Nexus coding job ({job.get_action_display()}, {job.get_agent_display()}) for work item "
        f"[{_identifier(job)}]({url}).",
        "",
        f"**Outcome:** {_OUTCOME_LINES[JobOutcome(data['outcome'])]}",
        "",
        f"Job `{job.id}`. Review the changes before merging: they were written by a coding agent.",
    ]
    reported = _reported(data)
    if reported:
        parts += ["", "What the agent reported:", "", _fence(reported)]
    body = "\n".join(parts)
    return body if len(body) <= BODY_MAX else body[:BODY_MAX]


# --------------------------------------------------------------------------- the push


@dataclass
class Published:
    pr_url: str
    branch: str


def _expect(response, status: int, what: str):
    if response.status_code != status:
        raise PublishError(f"GitHub refused to {what}: {github._message(response)}.")
    return response.json()


def _pull_request_url(repo: Repo, url) -> str:
    expected = f"{github.web_url()}/{repo.owner}/{repo.name}/pull/".lower()
    if not isinstance(url, str) or not url.lower().startswith(expected) or not url[len(expected) :].isdigit():
        raise PublishError("GitHub's answer has no link to the pull request.")
    return url


def _as_text(content: str) -> str | None:
    """A file's content as text when it is UTF-8 without NUL characters; None for binary content."""
    raw = base64.b64decode(content)
    if b"\0" in raw:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _push_and_open(job: CodingJob, changes: CodingJobChanges, data: dict, repo: Repo, default_branch: str) -> Published:
    workflows = [f["path"] for f in changes.files if f["path"].lower().startswith(".github/workflows/")]
    if workflows:
        # The App cannot change CI workflows (no workflows permission), and changes that would run with the
        # repository's secrets are a person's to make.
        raise PublishError(f"The job changed CI workflows ({workflows[0]}), which jobs may not push.")
    token = github.repo_token(repo, github.PUSH_PERMISSIONS)
    branch = branch_name(job)
    with github.client(token.token) as http:
        info = github.request(http, "GET", repo.path)
        if info.status_code != 200:
            raise PublishError(f"GitHub did not describe {repo.full_name}: {github._message(info)}.")
        repo_default = str(info.json().get("default_branch") or "")
        check_branch(branch, [default_branch, repo_default])

        base = github.request(http, "GET", f"{repo.path}/git/commits/{changes.base_commit}")
        if base.status_code == 404:
            raise PublishError(
                f"The commit the job started from ({changes.base_commit[:12]}) is not in {repo.full_name}."
            )
        base_tree = _expect(base, 200, "read the commit the job started from")["tree"]["sha"]

        entries = []
        for file in changes.files:
            if file.get("deleted"):
                entries.append({"path": file["path"], "mode": "100644", "type": "blob", "sha": None})
                continue
            text = _as_text(file["content"])
            if text is not None:
                # Text goes in the tree itself: one request for all of it, not one per file (GitHub limits how fast
                # content can be created).
                entries.append({"path": file["path"], "mode": file["mode"], "type": "blob", "content": text})
                continue
            blob = github.request(
                http, "POST", f"{repo.path}/git/blobs", json={"content": file["content"], "encoding": "base64"}
            )
            sha = _expect(blob, 201, f"store {file['path']}")["sha"]
            entries.append({"path": file["path"], "mode": file["mode"], "type": "blob", "sha": sha})
        tree = github.request(http, "POST", f"{repo.path}/git/trees", json={"base_tree": base_tree, "tree": entries})
        tree_sha = _expect(tree, 201, "store the changed files")["sha"]
        if tree_sha == base_tree:
            raise PublishError("The job's changes are already in the repository: there is nothing to push.")

        message = f"{_identifier(job)}: {job.get_action_display()}\n\nCoding job {job.id}."
        commit = github.request(
            http,
            "POST",
            f"{repo.path}/git/commits",
            json={"message": message, "tree": tree_sha, "parents": [changes.base_commit]},
        )
        commit_sha = _expect(commit, 201, "make the commit")["sha"]

        # The job may have been cancelled meanwhile: nothing is pushed for an ended job.
        if not CodingJob.all_objects.filter(pk=job.pk, outcome__isnull=True).exists():
            raise PublishError("The job ended before its branch was pushed.")
        # Created, never updated: a branch that exists already (the default branch included) is never moved.
        ref = github.request(
            http, "POST", f"{repo.path}/git/refs", json={"ref": f"refs/heads/{branch}", "sha": commit_sha}
        )
        if ref.status_code == 422:
            raise PublishError(f"The branch {branch} already exists in {repo.full_name}; it was left as it is.")
        _expect(ref, 201, f"create the branch {branch}")

        draft = data["outcome"] == JobOutcome.BUG_FOUND
        payload = {
            "title": pull_request_title(job, data["outcome"]),
            "head": branch,
            "base": default_branch,
            "body": pull_request_body(job, data),
            "draft": draft,
            "maintainer_can_modify": False,
        }
        pull = github.request(http, "POST", f"{repo.path}/pulls", json=payload)
        if pull.status_code == 422 and draft and "draft" in github._message(pull).lower():
            # Draft pull requests are not available on every plan: open a normal one instead.
            payload["draft"] = False
            pull = github.request(http, "POST", f"{repo.path}/pulls", json=payload)
        if pull.status_code != 201:
            raise PublishError(
                f"The changes are on the branch {branch}, but GitHub refused to open the pull request: "
                f"{github._message(pull)}."
            )
        return Published(pr_url=_pull_request_url(repo, pull.json().get("html_url")), branch=branch)


def _keep_orphan(job: CodingJob, published: Published) -> None:
    """The pull request was opened but the outcome could not be applied (the job ended meanwhile, or an error): the job
    keeps the link, and the audit trail says what happened."""
    from plane.coding.audit import record

    # A job that is still active ends now, with the link in its reason; one that ended stays as it ended.
    _end_with_error(
        job,
        f"The pull request {published.pr_url} was opened, but the outcome could not be applied. Review it there.",
    )
    CodingJob.all_objects.filter(pk=job.pk, pr_url="").update(pr_url=published.pr_url, pr_branch=published.branch)
    record(
        job.workspace_id,
        "job.pull_request_kept",
        "job",
        job.id,
        actor_name="CRM",
        project_id=job.project_id,
        pr_url=published.pr_url,
        pr_branch=published.branch,
    )


def _end_with_error(job: CodingJob, reason: str) -> None:
    try:
        apply_result(job, {"outcome": JobOutcome.JOB_ERROR.value, "reason": reason[:2000]})
    except (Conflict, InvalidResult):
        pass


def publish_job(job_id) -> str | None:
    """Push the job's changes and open its pull request, then apply its outcome. Returns the pull request's link, or
    None when the job ended without one (a job error with the reason, or it had already ended)."""
    job = (
        CodingJob.all_objects.select_related("issue", "issue__project", "workspace", "requested_by")
        .filter(pk=job_id)
        .first()
    )
    changes = CodingJobChanges.objects.filter(job_id=job_id).first()
    if job is None or changes is None:
        return None
    try:
        if job.outcome is not None:
            return None
        data = dict(changes.result)
        if job.deleted_at is not None:
            # The work item was deleted during the job: nothing to open a pull request for.
            apply_result(job, data, no_pr_reason="the work item was deleted during the job")
            return None
        coding_settings = ProjectCodingSettings.objects.filter(project_id=job.project_id).first()
        repo = github.parse_repo(coding_settings.repo_url) if coding_settings else None
        if repo is None:
            raise PublishError("The project's repository is no longer a GitHub repository.")
        # Shown on the work item while the push runs.
        CodingJob.all_objects.filter(pk=job.pk).update(progress="Opening a pull request.", progress_at=timezone.now())
        try:
            published = _push_and_open(job, changes, data, repo, coding_settings.default_branch)
        except GitHubError as error:
            raise PublishError(error.message) from error
        # Unlike the agent's fields, the pull request's link and branch are the CRM's own.
        try:
            apply_result(job, data, pr_url=published.pr_url, pr_branch=published.branch)
        except Exception:
            # The job ended meanwhile (cancelled, or timed out waiting for this): the pull request is open anyway, so
            # the job keeps its link and the audit trail says so.
            _keep_orphan(job, published)
            raise
        return published.pr_url
    except PublishError as error:
        machine = f" on {job.ran_on_name}" if job.ran_on_name else " on the machine"
        _end_with_error(
            job,
            f"Could not open the pull request: {error.message} The changes stay in the job's folder{machine}.",
        )
        return None
    except (Conflict, InvalidResult):
        return None
    except Exception:
        logger.exception("coding: publishing job %s failed", job.id)
        _end_with_error(job, "Could not open the pull request: something went wrong on the CRM's side. Retry the job.")
        return None
    finally:
        with transaction.atomic():
            CodingJobChanges.objects.filter(pk=changes.pk).delete(soft=False)
