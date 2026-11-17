# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Machines: what people do with them (owner and workspace admin), and what the machine itself calls.

People (public API and web app, mounted twice like every coding endpoint):
- Workspace members and admins list, add, rename, approve and remove their own machines. Guests get 403.
- Workspace admins also list every machine in the workspace and revoke any of them.
- Someone else's machine is 404 to a member and 403 to an admin for anything but reading and revoking.

The machine (public API only, authenticated by its own key, never by a person's token or cookie):
- `POST /api/v1/coding-machines/join/` trades a join code for the key.
- `POST /api/v1/coding-machines/heartbeat/` with `Authorization: Bearer <key>` keeps it online, carries its report and
  the jobs it runs, and answers with new jobs and jobs to stop (`plane.coding.dispatch`).
- `POST /api/v1/coding-machines/jobs/events/` sends progress lines for its running jobs.
- `POST /api/v1/coding-machines/jobs/<job_id>/result/` sends a job's result, which `outcomes.apply_result` applies.
"""

from functools import cached_property

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from plane.coding import a2a, dispatch, machines
from plane.coding.exceptions import CodingError, Forbidden, NotFound
from plane.coding.models import HEARTBEAT_SECONDS, CodingMachine
from plane.coding.serializers import (
    CodingMachineSerializer,
    HeartbeatSerializer,
    JobEventsSerializer,
    JobResultSerializer,
    JoinSerializer,
    AddMachineSerializer,
    MachineNameSerializer,
)
from plane.db.models import Workspace, WorkspaceMember
from plane.db.models.api import AGENT_SESSION_TOKEN_LABEL, APIToken

from .base import CodingEndpointMixin

ADMIN_ROLE = 20


class _WorkspaceMachines(CodingEndpointMixin):
    @cached_property
    def workspace(self) -> Workspace:
        workspace = Workspace.objects.filter(slug=self.kwargs["slug"]).first()
        if workspace is None:
            raise NotFound("Workspace not found.")
        return workspace

    @cached_property
    def role(self) -> int:
        role = (
            WorkspaceMember.objects.filter(workspace=self.workspace, member=self.request.user, is_active=True)
            .values_list("role", flat=True)
            .first()
        )
        if role is None:
            raise Forbidden("You are not a member of this workspace.")
        return role

    @property
    def is_admin(self) -> bool:
        return self.role >= ADMIN_ROLE

    def require_member(self):
        if not machines.owner_may_use_machines(self.request.user, self.workspace):
            raise Forbidden("Guests cannot have machines: they cannot run coding jobs.")

    def refuse_agent_sessions(self):
        """Adding and approving are the owner's own check of which computers get their jobs. An in-app agent works
        from text anyone in the workspace can write, so its session token may not do either."""
        token = getattr(self.request, "auth", None)
        if isinstance(token, str) and APIToken.objects.filter(token=token, label=AGENT_SESSION_TOKEN_LABEL).exists():
            raise Forbidden("An agent session cannot add or approve machines.", code="AGENT_SESSION_NOT_ALLOWED")

    def require_admin(self):
        if not self.is_admin:
            raise Forbidden("Only workspace admins can do this.")

    def queryset(self):
        return CodingMachine.objects.filter(workspace=self.workspace).select_related("owner")

    def get_machine(self) -> CodingMachine:
        """A machine the caller may see: their own, or any in the workspace for an admin."""
        self.role  # noqa: B018 - 403 before 404 for non-members
        machine = self.queryset().filter(pk=self.kwargs["machine_id"]).first()
        if machine is None or (machine.owner_id != self.request.user.id and not self.is_admin):
            raise NotFound("Machine not found.")
        return machine

    def get_own_machine(self) -> CodingMachine:
        """A machine the caller manages: their own, or, for a workspace admin, a bot member's. A bot never manages
        machines, its own included: an admin adds and approves them for it."""
        machine = self.get_machine()
        if self.request.user.is_bot:
            raise Forbidden("A bot member's machines are managed by workspace admins.", code="BOT_NOT_ALLOWED")
        if machine.owner.is_bot:
            if not self.is_admin:
                raise Forbidden("Only workspace admins manage a bot member's machines.")
            return machine
        if machine.owner_id != self.request.user.id:
            raise Forbidden("Only the machine's owner can do this.")
        self.require_member()
        return machine

    @staticmethod
    def payload(machine, **extra) -> dict:
        return {**CodingMachineSerializer(machine).data, **extra}


class CodingMachineListMixin(_WorkspaceMachines):
    def get(self, request, slug):
        """The caller's own machines in this workspace, oldest first."""
        self.require_member()
        mine = self.queryset().filter(owner=request.user)
        return Response(CodingMachineSerializer(mine, many=True).data)

    def post(self, request, slug):
        """Add a machine. The answer carries `join_code` (and `join_code_expires_at`): shown once, never again.

        `owner` (a bot member's id) adds one for that bot: workspace admins only. A bot cannot add machines."""
        self.refuse_agent_sessions()
        if request.user.is_bot:
            raise Forbidden("A bot member's machines are added by workspace admins.", code="BOT_NOT_ALLOWED")
        serializer = AddMachineSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        owner = request.user
        if data.get("owner"):
            self.require_admin()
            owner = machines.bot_owner(self.workspace, data["owner"])
        else:
            self.require_member()
        machine, code = machines.add_machine(self.workspace, owner, data["name"])
        return Response(self.payload(machine, join_code=code), status=status.HTTP_201_CREATED)


class CodingMachineAllMixin(_WorkspaceMachines):
    def get(self, request, slug):
        """Every machine in the workspace, whoever owns it. Workspace admins only."""
        self.require_admin()
        return Response(CodingMachineSerializer(self.queryset().order_by("owner_id", "created_at"), many=True).data)


class CodingMachineDetailMixin(_WorkspaceMachines):
    def get(self, request, slug, machine_id):
        return Response(self.payload(self.get_machine()))

    def patch(self, request, slug, machine_id):
        """Rename. The owner only."""
        machine = self.get_own_machine()
        serializer = MachineNameSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        machine.name = serializer.validated_data["name"]
        machine.save(update_fields=["name", "updated_at"])
        return Response(self.payload(machine))

    def delete(self, request, slug, machine_id):
        """Remove for good. The owner only (a workspace admin for a bot's); the machine's key stops working at once."""
        machine = self.get_machine()
        if request.user.is_bot or (
            machine.owner_id != request.user.id and not (machine.owner.is_bot and self.is_admin)
        ):
            raise Forbidden("Only the machine's owner can remove it. Admins can revoke it.")
        machines.remove(machine)
        return Response(status=status.HTTP_204_NO_CONTENT)


class CodingMachineApproveMixin(_WorkspaceMachines):
    def post(self, request, slug, machine_id):
        """Approve a machine that has joined, so it can take jobs. The owner only."""
        machine = self.get_own_machine()
        self.refuse_agent_sessions()
        return Response(self.payload(machines.approve(machine)))


class CodingMachineRevokeMixin(_WorkspaceMachines):
    def post(self, request, slug, machine_id):
        """Cut a machine off: its key stops working and it gets no jobs. Workspace admins only."""
        self.require_admin()
        return Response(self.payload(machines.revoke(self.get_machine(), request.user)))


# The machine's own endpoints.


class _JoinThrottle(SimpleRateThrottle):
    scope = "coding_machine_join"
    rate = "30/hour"

    def get_cache_key(self, request, view):
        return f"{self.scope}:{self.get_ident(request)}"


class _HeartbeatThrottle(SimpleRateThrottle):
    scope = "coding_machine_heartbeat"
    # A heartbeat every 15 s is 240 an hour; this leaves room for reconnects.
    rate = "720/hour"

    def get_cache_key(self, request, view):
        key = _bearer(request)
        return f"{self.scope}:{machines._hash(key)}" if key else None


def _bearer(request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, value = header.partition(" ")
    return value.strip() if scheme.lower() == "bearer" else ""


class _MachineEndpoint(APIView):
    # Machines hold no user session or personal token; each endpoint checks what it needs.
    authentication_classes: list = []
    permission_classes = [AllowAny]

    def handle_exception(self, exc):
        if isinstance(exc, CodingError):
            return Response(exc.body(), status=exc.http_status)
        return super().handle_exception(exc)

    @staticmethod
    def invalid(errors) -> Response:
        return Response({"error": "The request is not valid.", "errors": errors}, status=400)


class MachineJoinEndpoint(_MachineEndpoint):
    throttle_classes = [_JoinThrottle]

    def post(self, request):
        """Trade a join code for this machine's key. The key is in this answer only."""
        serializer = JoinSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        machine, key = machines.join(
            data["code"], hostname=data.get("hostname", ""), os=data.get("os", ""), version=data.get("version", "")
        )
        return Response(
            {
                "machine_id": str(machine.id),
                "key": key,
                "name": machine.name,
                "workspace_slug": machine.workspace.slug,
                "state": machine.state,
                "heartbeat_seconds": HEARTBEAT_SECONDS,
            },
            status=status.HTTP_201_CREATED,
        )


class MachineHeartbeatEndpoint(_MachineEndpoint):
    throttle_classes = [_HeartbeatThrottle]

    def post(self, request):
        """Keep the machine online and store its report. 401 means the key will never work again: stop."""
        machine = machines.authenticate_key(_bearer(request))
        serializer = HeartbeatSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        machine = machines.heartbeat(machine, data)
        handout = dispatch.heartbeat_jobs(machine, data.get("running"))
        return Response(
            {
                "machine_id": str(machine.id),
                "name": machine.name,
                "state": machine.state,
                "heartbeat_seconds": HEARTBEAT_SECONDS,
                "jobs": handout.jobs,
                "cancel": handout.cancel,
            }
        )


class _JobEventsThrottle(_HeartbeatThrottle):
    scope = "coding_machine_events"
    # The machine sends one batch for all its jobs at most every few seconds.
    rate = "1800/hour"


class _JobResultThrottle(_HeartbeatThrottle):
    scope = "coding_machine_result"
    rate = "360/hour"


class MachineJobEventsEndpoint(_MachineEndpoint):
    throttle_classes = [_JobEventsThrottle]

    def post(self, request):
        """Progress lines for the machine's running jobs. `ended` lists the jobs it should stop."""
        machine = machines.authenticate_key(_bearer(request))
        serializer = JobEventsSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        ended = dispatch.record_events(machine, serializer.validated_data["jobs"])
        return Response({"ended": ended})


class MachineJobResultEndpoint(_MachineEndpoint):
    throttle_classes = [_JobResultThrottle]

    def post(self, request, job_id):
        """The job's result, with the files it changed. The same result again changes nothing; a job that has ended
        otherwise is 409. With changes, the job stays `running` until the CRM has opened its pull request."""
        machine = machines.authenticate_key(_bearer(request))
        serializer = JobResultSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        data = serializer.validated_data
        applied = dispatch.apply_machine_result(
            machine, job_id, data["result"], data.get("changes"), changes_note=data.get("changes_note", "")
        )
        job = applied.job
        return Response(
            {"job_id": str(job.id), "status": job.status, "outcome": job.outcome, "changed": applied.changed}
        )


class _A2AThrottle(_HeartbeatThrottle):
    scope = "coding_machine_a2a"
    # A machine reads each waiting job's task every few seconds.
    rate = "3600/hour"


class MachineA2AEndpoint(_MachineEndpoint):
    """The CRM agent's A2A endpoint (`plane.coding.a2a`): JSON-RPC 2.0, authenticated by the machine's key."""

    throttle_classes = [_A2AThrottle]

    def handle_exception(self, exc):
        from rest_framework.exceptions import ParseError

        if isinstance(exc, ParseError):
            return Response(a2a._error(None, a2a.PARSE_ERROR, "The body is not JSON."))
        return super().handle_exception(exc)

    def post(self, request):
        machine = machines.authenticate_key(_bearer(request))
        answer = a2a.handle(machine, request.data)
        if answer is None:
            return Response(status=status.HTTP_204_NO_CONTENT)
        return Response(answer)


class A2AAgentCardEndpoint(APIView):
    """The CRM agent's A2A agent card. Public: it says what the agent does and how to authenticate, nothing else."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    def get(self, request):
        return Response(a2a.agent_card())
