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
- `POST /api/v1/coding-machines/heartbeat/` with `Authorization: Bearer <key>` keeps it online and carries its report.
"""

from functools import cached_property

from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from plane.coding import machines
from plane.coding.exceptions import CodingError, Forbidden, NotFound
from plane.coding.models import HEARTBEAT_SECONDS, CodingMachine
from plane.coding.serializers import (
    CodingMachineSerializer,
    HeartbeatSerializer,
    JoinSerializer,
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
        machine = self.get_machine()
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
        """Add a machine. The answer carries `join_code` (and `join_code_expires_at`): shown once, never again."""
        self.require_member()
        self.refuse_agent_sessions()
        serializer = MachineNameSerializer(data=request.data)
        if not serializer.is_valid():
            return self.invalid(serializer.errors)
        machine, code = machines.add_machine(self.workspace, request.user, serializer.validated_data["name"])
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
        """Remove for good. The owner only; the machine's key stops working at once."""
        machine = self.get_machine()
        if machine.owner_id != request.user.id:
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
        machine = machines.heartbeat(machine, serializer.validated_data)
        return Response(
            {
                "machine_id": str(machine.id),
                "name": machine.name,
                "state": machine.state,
                "heartbeat_seconds": HEARTBEAT_SECONDS,
                # Step 4 hands out jobs here.
                "jobs": [],
            }
        )
