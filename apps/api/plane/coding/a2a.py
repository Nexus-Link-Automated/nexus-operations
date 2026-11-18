# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The CRM agent's A2A endpoint, where the coding agent on a machine talks to it.

[A2A](https://a2a-protocol.org) is JSON-RPC 2.0 over HTTP. The CRM hosts the endpoint and each coding job is one A2A
task (`id` = the job's id, `contextId` = its work item's id). Machines only ever connect out, so the machine is the A2A
client and reads answers back with `tasks/get`; it authenticates with its machine key, and sees only the jobs it runs.

| Method | Does |
| --- | --- |
| `message/send` | the coding agent's question for the task (`message.taskId`); answers the task, `input-required` |
| `tasks/get` | the task: its state, and its history (each question, then its answer) |
| `tasks/cancel` | refused (`TaskNotCancelableError`): only people cancel coding jobs, in the CRM |

Task states follow the job: queued → `submitted`, running → `working`, waiting for an answer → `input-required`,
finished → `completed` (`failed` for a job error), cancelled → `canceled`. In the history the coding agent's
questions have role `user` and the answers role `agent`; an answer's `metadata` says who gave it (`crm_agent`,
`person`, or `nobody` when none came in time), which question it answers (`question_message_id`), and `prompt`: the
message the machine gives the coding agent next, written by the CRM.
"""

from plane.coding import questions
from plane.coding.exceptions import CodingError, NotFound
from plane.coding.instructions import answer_message
from plane.coding.models import CodingJob, CodingMachine, JobOutcome, JobStatus, QuestionStatus
from plane.utils.host import base_host

__all__ = ["PROTOCOL_VERSION", "agent_card", "handle"]

PROTOCOL_VERSION = "0.3.0"

# JSON-RPC and A2A error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
TASK_NOT_FOUND = -32001
TASK_NOT_CANCELABLE = -32002
UNSUPPORTED_OPERATION = -32004

ENDPOINT = "/api/v1/coding-machines/a2a/"


def agent_card() -> dict:
    """The CRM agent's A2A agent card."""
    url = f"{base_host(request=None, is_app=False).rstrip('/')}{ENDPOINT}"
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "name": "Nexus CRM agent",
        "description": (
            "Answers questions a coding agent asks during a coding job, from the job's work item or by asking the "
            "person who started the job. Each coding job is a task."
        ),
        "url": url,
        "preferredTransport": "JSONRPC",
        "version": "1.0.0",
        "capabilities": {"streaming": False, "pushNotifications": False, "stateTransitionHistory": False},
        "securitySchemes": {"machineKey": {"type": "http", "scheme": "bearer"}},
        "security": [{"machineKey": []}],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            {
                "id": "answer_question",
                "name": "Answer a coding job's question",
                "description": "Send the question as a text message on the job's task; read the answer with tasks/get.",
                "tags": ["coding", "questions"],
            }
        ],
    }


class RpcError(Exception):
    def __init__(self, code: int, message: str, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _state(job: CodingJob) -> str:
    if job.status == JobStatus.QUEUED:
        return "submitted"
    if job.status == JobStatus.NEEDS_INPUT:
        return "input-required"
    if job.status == JobStatus.CANCELLED:
        return "canceled"
    if job.status == JobStatus.FINISHED:
        return "failed" if job.outcome == JobOutcome.JOB_ERROR else "completed"
    return "working"


def _text_message(role: str, message_id: str, text: str, job: CodingJob, metadata: dict | None = None) -> dict:
    return {
        "kind": "message",
        "role": role,
        "messageId": message_id,
        "taskId": str(job.id),
        "contextId": str(job.issue_id),
        "parts": [{"kind": "text", "text": text}],
        **({"metadata": metadata} if metadata else {}),
    }


def _history(job: CodingJob) -> list:
    history = []
    for question in job.questions.select_related("answered_by").order_by("seq"):
        history.append(_text_message("user", question.message_id, question.question, job))
        if question.is_open:
            continue
        answered_by = (
            "crm_agent"
            if question.answered_by_agent
            else "person"
            if question.status == QuestionStatus.ANSWERED
            else "nobody"
        )
        history.append(
            _text_message(
                "agent",
                f"answer-{question.id}",
                question.answer,
                job,
                {
                    "answered_by": answered_by,
                    "name": questions._who(question),
                    "question_message_id": question.message_id,
                    # What the machine gives the coding agent next: the answer, fenced, in the CRM's words.
                    "prompt": answer_message(answered_by, questions._who(question), question.answer),
                },
            )
        )
    return history


def task(job: CodingJob, history_length: int | None = None) -> dict:
    history = _history(job)
    if history_length is not None:
        history = history[-history_length:] if history_length > 0 else []
    return {
        "kind": "task",
        "id": str(job.id),
        "contextId": str(job.issue_id),
        "status": {"state": _state(job), "timestamp": job.updated_at.isoformat()},
        "history": history,
    }


def _job(machine: CodingMachine, task_id) -> CodingJob:
    job = CodingJob.all_objects.filter(pk=task_id, ran_on=machine).first() if _uuid(task_id) else None
    if job is None:
        raise RpcError(TASK_NOT_FOUND, "Task not found.")
    return job


def _uuid(value) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
        return True
    except ValueError:
        return False


def _send(machine: CodingMachine, params: dict) -> dict:
    message = params.get("message")
    if not isinstance(message, dict):
        raise RpcError(INVALID_PARAMS, "params.message is required.")
    task_id, message_id = message.get("taskId"), message.get("messageId")
    if not isinstance(message_id, str) or not message_id or len(message_id) > 100:
        raise RpcError(INVALID_PARAMS, "message.messageId is required (at most 100 characters).")
    if message.get("role") != "user":
        raise RpcError(INVALID_PARAMS, 'message.role must be "user".')
    parts = message.get("parts")
    if not isinstance(parts, list) or not parts:
        raise RpcError(INVALID_PARAMS, "message.parts is required.")
    texts = []
    for part in parts:
        if not isinstance(part, dict) or part.get("kind") != "text" or not isinstance(part.get("text"), str):
            raise RpcError(UNSUPPORTED_OPERATION, "Only text parts are supported.")
        texts.append(part["text"])
    job = _job(machine, task_id)
    try:
        questions.ask(machine, job.id, message_id, "\n".join(texts))
    except CodingError as error:
        raise RpcError(INVALID_REQUEST if error.http_status != 404 else TASK_NOT_FOUND, error.message, error.body())
    job.refresh_from_db()
    return task(job)


def handle(machine: CodingMachine, body) -> dict | None:
    """One JSON-RPC request → its response (None for a notification, which gets no answer)."""
    if not isinstance(body, dict) or body.get("jsonrpc") != "2.0" or not isinstance(body.get("method"), str):
        return _error(None, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.")
    request_id = body.get("id")
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    method = body["method"]
    try:
        if method == "message/send":
            result = _send(machine, params)
        elif method == "tasks/get":
            length = params.get("historyLength")
            if length is not None and (not isinstance(length, int) or length < 0):
                raise RpcError(INVALID_PARAMS, "historyLength must be a whole number.")
            result = task(_job(machine, params.get("id")), length)
        elif method == "tasks/cancel":
            _job(machine, params.get("id"))
            raise RpcError(TASK_NOT_CANCELABLE, "Only people cancel coding jobs, in the CRM.")
        else:
            raise RpcError(METHOD_NOT_FOUND, f"Method {method[:64]} is not supported.")
    except RpcError as error:
        return _error(request_id, error.code, error.message, error.data)
    except NotFound as error:
        return _error(request_id, TASK_NOT_FOUND, error.message)
    if "id" not in body:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id, code: int, message: str, data=None) -> dict:
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}
