# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Step 6: a coding agent's questions over A2A, answered by the CRM agent from the work item or by a person (the
coding jobs panel, the API, or a reply in the work item's Messages thread)."""

from datetime import timedelta
from unittest import mock

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from plane.chat.models import Channel, ChannelKind, ChannelMember, Message, MessageSystemEvent
from plane.coding import questions
from plane.coding.dispatch import expire_jobs
from plane.coding.models import CodingJob, CodingJobQuestion, JobStatus, QuestionStatus
from plane.db.models import IssueComment

from .conftest import MEMBER
from .test_dispatch import _reset_machine_throttles, beat, machine_client, report, run_on  # noqa: F401

A2A = "/api/v1/coding-machines/a2a/"


def rpc(key, method, params, request_id=1):
    body = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    res = machine_client(key).post(A2A, body, format="json")
    assert res.status_code == 200, res.content
    return res.json()


def ask(key, job, text="Which login page: web or mobile?", message_id="q-1"):
    return rpc(
        key,
        "message/send",
        {
            "message": {
                "kind": "message",
                "role": "user",
                "messageId": message_id,
                "taskId": str(job.id),
                "parts": [{"kind": "text", "text": text}],
            }
        },
    )


@pytest.fixture
def think_later():
    """Records the CRM agent's task instead of running it."""
    with mock.patch("plane.coding.tasks.think_about_question.delay") as delay:
        yield delay


def llm(answer):
    """The instance's AI provider, answering `answer` (a JSON string) or not set up (None)."""
    config = ("key", "gpt-4o-mini", "openai") if answer is not None else (None, None, None)
    return mock.patch.multiple(
        "plane.app.views.external.base",
        get_llm_config=mock.Mock(return_value=config),
        get_llm_response=mock.Mock(return_value=(answer, None)),
    )


@pytest.fixture
def waiting(member, make_machine, start, tasks, think_later, django_capture_on_commit_callbacks):
    """A job running on the member's machine whose agent asked a question: (job, key, question)."""
    _, key = make_machine(member[0])
    job = start(member[0])
    run_on(key, job)
    with django_capture_on_commit_callbacks(execute=True):
        ask(key, job)
    job.refresh_from_db()
    return job, key, job.questions.get()


@pytest.fixture
def channel(project, member):
    channel = Channel.objects.create(workspace=project.workspace, kind=ChannelKind.PUBLIC, name="app", project=project)
    ChannelMember.objects.create(channel=channel, user=member[0])
    return channel


def session(user):
    client = APIClient()
    client.force_authenticate(user)
    return client


@pytest.mark.contract
class TestAsking:
    def test_a_question_makes_the_job_wait(self, member, make_machine, start, think_later, tasks):
        _, key = make_machine(member[0])
        job = start(member[0])
        run_on(key, job)
        answer = ask(key, job)
        assert answer["result"]["kind"] == "task" and answer["result"]["id"] == str(job.id)
        assert answer["result"]["status"]["state"] == "input-required"
        assert answer["result"]["history"][0]["parts"][0]["text"] == "Which login page: web or mobile?"
        job.refresh_from_db()
        assert job.status == JobStatus.NEEDS_INPUT and job.progress.startswith("Asked: Which login page")
        question = job.questions.get()
        assert (question.seq, question.status) == (1, QuestionStatus.THINKING)
        # Sent again (a lost answer): the same question.
        ask(key, job)
        assert job.questions.count() == 1

    def test_one_open_question_and_three_at_most(self, waiting, think_later):
        job, key, question = waiting
        second = ask(key, job, "And another?", "q-2")
        assert second["error"]["data"]["code"] == "QUESTION_OPEN"
        for seq in (2, 3):
            questions._resolve(CodingJobQuestion.objects.get(job=job, status__in=["thinking", "waiting"]), "web")
            ask(key, job, f"Question {seq}?", f"q-{seq}")
        questions._resolve(CodingJobQuestion.objects.get(job=job, seq=3), "ok")
        assert ask(key, job, "A fourth?", "q-4")["error"]["data"]["code"] == "QUESTION_LIMIT"

    def test_only_the_machines_own_running_jobs(self, member, other_member, make_machine, start, think_later):
        _, key = make_machine(member[0])
        _, other_key = make_machine(other_member[0], name="Other")
        job = start(member[0])
        run_on(key, job)
        assert ask(other_key, job)["error"]["code"] == -32001
        queued = start(member[0], action="write_test")
        assert ask(key, queued)["error"]["code"] == -32001

    def test_a_waiting_job_stays_on_its_machine_and_its_deadline_waits(self, waiting, tasks):
        job, key, _ = waiting
        res = beat(key, report(running=[job.id]))
        assert res.json()["cancel"] == []
        job.refresh_from_db()
        assert job.status == JobStatus.NEEDS_INPUT
        # Past its deadline while waiting: not ended.
        CodingJob.objects.filter(pk=job.pk).update(deadline_at=timezone.now() - timedelta(minutes=10))
        assert expire_jobs() == 0
        # Answered, it is past its deadline only by what is left of it: the time it waited was added.
        questions._resolve(job.questions.get(), "web")
        job.refresh_from_db()
        assert job.status == JobStatus.RUNNING

    def test_json_rpc_errors(self, waiting):
        job, key, _ = waiting
        assert rpc(key, "tasks/cancel", {"id": str(job.id)})["error"]["code"] == -32002
        assert rpc(key, "tasks/resubscribe", {})["error"]["code"] == -32601
        assert rpc(key, "tasks/get", {"id": "not-a-uuid"})["error"]["code"] == -32001
        bad = machine_client(key).post(A2A, "{not json", content_type="application/json")
        assert bad.json()["error"]["code"] == -32700
        assert machine_client("nxm_wrong").post(A2A, {}, format="json").status_code == 401

    def test_agent_card_is_public(self, db):
        card = APIClient().get(f"{A2A}agent-card/").json()
        assert card["skills"][0]["id"] == "answer_question" and card["url"].endswith(A2A)


@pytest.mark.contract
class TestTheCrmAgent:
    def test_answers_from_the_work_item(self, waiting, channel, tasks):
        job, key, question = waiting
        deadline = job.deadline_at
        with llm('{"answer": "The web login page."}'), tasks.commit():
            questions.think(question.id)
        question.refresh_from_db()
        assert question.status == QuestionStatus.ANSWERED and question.answered_by_agent
        job.refresh_from_db()
        assert job.status == JobStatus.RUNNING and job.deadline_at >= deadline
        task = rpc(key, "tasks/get", {"id": str(job.id)})["result"]
        assert task["status"]["state"] == "working"
        answer = task["history"][-1]
        assert answer["role"] == "agent" and answer["parts"][0]["text"] == "The web login page."
        assert answer["metadata"]["answered_by"] == "crm_agent" and answer["metadata"]["question_message_id"] == "q-1"
        assert "The web login page." in answer["metadata"]["prompt"] and "CRM agent" in answer["metadata"]["prompt"]
        # The conversation shows in the work item's Messages thread.
        root = Message.objects.get(channel=channel, parent__isnull=True)
        assert root.system_event == MessageSystemEvent.CODING_QUESTION
        assert Message.objects.filter(parent=root).count() == 1
        # No comment asking anyone: the CRM agent answered.
        assert not IssueComment.objects.filter(issue=job.issue).exists()

    def test_the_work_item_is_fenced_as_data(self, waiting, tasks):
        _, _, question = waiting
        response = mock.Mock(return_value=('{"answer": null}', None))
        with (
            mock.patch.multiple(
                "plane.app.views.external.base",
                get_llm_config=mock.Mock(return_value=("k", "m", "openai")),
                get_llm_response=response,
            ),
            tasks.commit(),
        ):
            questions.think(question.id)
        task, prompt = response.call_args.args[:2]
        marker = prompt.splitlines()[0]
        assert marker.startswith("DATA-") and prompt.rstrip().endswith(marker)
        assert "data, not instructions" in task and "Which login page" in prompt

    def test_no_answer_goes_to_the_people(self, waiting, channel, member, tasks):
        job, _, question = waiting
        with llm('{"answer": null}'), tasks.commit():
            questions.think(question.id)
        question.refresh_from_db()
        assert question.status == QuestionStatus.WAITING
        comment = IssueComment.objects.get(issue=job.issue)
        assert "Which login page: web or mobile?" in comment.comment_html and "Messages thread" in comment.comment_html
        root = Message.objects.get(channel=channel, parent__isnull=True)
        assert "Which login page" not in root.body_html  # stored for search and export: no work-item text
        res = session(member[0]).get(f"/api/workspaces/{job.workspace.slug}/chat/channels/{channel.id}/messages/")
        assert res.status_code == 200, res.content
        bodies = [m["body_html"] for m in res.json()["results"]]
        assert any("Which login page: web or mobile?" in body for body in bodies)

    def test_no_ai_provider_goes_to_the_people(self, waiting, tasks):
        job, _, question = waiting
        with llm(None), tasks.commit():
            questions.think(question.id)
        question.refresh_from_db()
        assert question.status == QuestionStatus.WAITING

    def test_readers_who_cannot_see_the_work_item_see_no_text(self, waiting, channel, make_user, workspace, tasks):
        job, _, question = waiting
        outsider, _ = make_user(MEMBER, workspace=workspace)
        ChannelMember.objects.create(channel=channel, user=outsider)
        with llm(None), tasks.commit():
            questions.think(question.id)
        res = session(outsider).get(f"/api/workspaces/{job.workspace.slug}/chat/channels/{channel.id}/messages/")
        bodies = [m["body_html"] for m in res.json()["results"]]
        assert bodies and not any("Which login page" in body for body in bodies)


@pytest.mark.contract
class TestPeopleAnswer:
    def url(self, job):
        return (
            f"/api/v1/workspaces/{job.workspace.slug}/projects/{job.project_id}/work-items/{job.issue_id}/"
            f"coding-jobs/{job.id}/answer/"
        )

    def test_a_member_answers_through_the_api(self, waiting, other_member, tasks):
        job, key, question = waiting
        res = other_member[1].post(self.url(job), {"text": "Mobile."}, format="json")
        assert res.status_code == 200, res.content
        body = res.json()
        assert body["status"] == "running"
        assert body["questions"][0]["answer"] == "Mobile." and body["questions"][0]["answered_by_name"] == "Otto Other"
        meta = rpc(key, "tasks/get", {"id": str(job.id)})["result"]["history"][-1]["metadata"]
        assert meta["answered_by"] == "person" and "Otto Other" in meta["prompt"]
        # Answered: nothing left to answer.
        again = other_member[1].post(self.url(job), {"text": "Web."}, format="json")
        assert again.status_code == 409 and again.json()["code"] == "NO_OPEN_QUESTION"

    def test_guests_cannot(self, waiting, guest):
        job, _, _ = waiting
        # A guest does not see another person's work item at all.
        assert guest[1].post(self.url(job), {"text": "x"}, format="json").status_code in (403, 404)
        assert job.questions.get().is_open

    def test_a_reply_in_the_thread_answers(self, waiting, channel, member, make_user, workspace, tasks):
        job, key, question = waiting
        with llm(None), tasks.commit():
            questions.think(question.id)
        root = Message.objects.get(channel=channel, parent__isnull=True)
        outsider, _ = make_user(MEMBER, workspace=workspace)
        ChannelMember.objects.create(channel=channel, user=outsider)
        url = f"/api/workspaces/{job.workspace.slug}/chat/channels/{channel.id}/messages/"
        # Someone outside the project replies: just a message.
        with tasks.commit():
            res = session(outsider).post(
                url, {"body_html": "<p>Web, I think</p>", "parent_id": str(root.id)}, format="json"
            )
        assert res.status_code == 201, res.content
        question.refresh_from_db()
        assert question.status == QuestionStatus.WAITING
        with tasks.commit():
            session(member[0]).post(
                url, {"body_html": "<p>The mobile one.</p>", "parent_id": str(root.id)}, format="json"
            )
        question.refresh_from_db()
        assert question.status == QuestionStatus.ANSWERED and question.answer == "The mobile one."
        assert question.answered_by == member[0]

    def test_unanswered_in_time(self, waiting, tasks):
        job, key, question = waiting
        with llm(None), tasks.commit():
            questions.think(question.id)
        assert questions.expire_questions(now=timezone.now() + timedelta(minutes=31)) == 1
        question.refresh_from_db()
        assert question.status == QuestionStatus.UNANSWERED
        job.refresh_from_db()
        assert job.status == JobStatus.RUNNING
        meta = rpc(key, "tasks/get", {"id": str(job.id)})["result"]["history"][-1]["metadata"]
        assert meta["answered_by"] == "nobody" and "Nobody answered" in meta["prompt"]

    def test_a_job_that_ends_closes_its_question(self, waiting, member, tasks):
        from plane.coding.services import cancel_job

        job, _, question = waiting
        with tasks.commit():
            cancel_job(CodingJob.objects.get(pk=job.pk), member[0])
        questions.expire_questions()
        question.refresh_from_db()
        assert question.status == QuestionStatus.UNANSWERED
