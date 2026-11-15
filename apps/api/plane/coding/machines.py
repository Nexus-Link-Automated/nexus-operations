# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Registering machines and keeping track of them. The views check who may; these enforce the machine's own rules.

Secrets: a join code and a machine key are both random and shown once. Only their SHA-256 is stored, so a database
read does not give anyone a way in. A join code works once and expires after `JOIN_CODE_TTL`.
"""

import hashlib
import secrets
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone

from plane.coding.exceptions import CodingError, Conflict
from plane.coding.models import CodingMachine, MachineState
from plane.db.models import WorkspaceMember

JOIN_CODE_TTL = timedelta(minutes=30)
# Per owner and workspace, so a script cannot fill the table.
MAX_MACHINES_PER_OWNER = 20
KEY_PREFIX = "nxm_"
MEMBER_ROLE = 15

# Crockford base32 without the look-alikes, so a code read off a screen types back the same.
_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_LENGTH = 16  # 80 bits


class MachineAuthError(CodingError):
    """The machine's key does not let it in. `code` says why, so the machine service knows whether to stop."""

    http_status = 401


class MachineOwnerNotAllowed(CodingError):
    """The key is fine, but its owner left the workspace or became a guest. The machine may retry later."""

    http_status = 403
    code = "MACHINE_OWNER_NOT_ALLOWED"


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def normalize_join_code(code: str) -> str:
    """Upper-case, drop separators and map the letters people mistype for digits (O, I, L)."""
    cleaned = "".join(ch for ch in str(code).upper() if ch not in "- \t")
    return cleaned.translate(str.maketrans({"O": "0", "I": "1", "L": "1"}))


def _new_join_code() -> str:
    raw = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))
    return "-".join(raw[i : i + 4] for i in range(0, _CODE_LENGTH, 4))


def owner_may_use_machines(user, workspace) -> bool:
    """Members and admins of the workspace; guests cannot run coding jobs, so they get no machines either."""
    return WorkspaceMember.objects.filter(
        workspace=workspace, member=user, is_active=True, role__gte=MEMBER_ROLE, member__is_active=True
    ).exists()


def add_machine(workspace, owner, name: str) -> tuple[CodingMachine, str]:
    """A new pending machine and its join code. The code is returned here and never again."""
    if CodingMachine.objects.filter(workspace=workspace, owner=owner).count() >= MAX_MACHINES_PER_OWNER:
        raise Conflict(
            f"You can have at most {MAX_MACHINES_PER_OWNER} machines in this workspace. Remove one first.",
            code="MACHINE_LIMIT",
        )
    for _ in range(3):
        code = _new_join_code()
        try:
            with transaction.atomic():
                machine = CodingMachine.objects.create(
                    workspace=workspace,
                    owner=owner,
                    name=name,
                    join_code_hash=_hash(normalize_join_code(code)),
                    join_code_expires_at=timezone.now() + JOIN_CODE_TTL,
                )
            return machine, code
        except IntegrityError:  # pragma: no cover - an 80-bit collision
            continue
    raise CodingError("Could not create a join code. Try again.")  # pragma: no cover


def join(code: str, *, hostname: str = "", os: str = "", version: str = "") -> tuple[CodingMachine, str]:
    """Trade a join code for the machine's own key. The code stops working, whatever happens next."""
    code_hash = _hash(normalize_join_code(code))
    key = None
    with transaction.atomic():
        machine = (
            CodingMachine.objects.select_for_update()
            .select_related("workspace", "owner")
            .filter(join_code_hash=code_hash)
            .first()
        )
        if machine is None:
            raise CodingError("This join code is not valid or has expired.", code="JOIN_CODE_INVALID")
        # Single use: the hash goes now, expired or not. Saved before raising, which would roll it back.
        machine.join_code_hash = None
        usable = (
            machine.state == MachineState.PENDING
            and not machine.join_code_expired
            and owner_may_use_machines(machine.owner, machine.workspace)
        )
        if usable:
            key = KEY_PREFIX + secrets.token_urlsafe(32)
            now = timezone.now()
            machine.key_hash = _hash(key)
            machine.join_code_expires_at = None
            machine.state = MachineState.AWAITING_APPROVAL
            machine.joined_at = now
            machine.last_seen_at = now
            machine.hostname, machine.os, machine.version = hostname, os, version
        machine.save()
    if key is None:
        raise CodingError("This join code is not valid or has expired.", code="JOIN_CODE_INVALID")
    return machine, key


def authenticate_key(key: str) -> CodingMachine:
    """The machine a key belongs to, if it may still connect. Raises `MachineAuthError` otherwise."""
    if not key or not key.startswith(KEY_PREFIX):
        raise MachineAuthError("Machine key missing or malformed.", code="MACHINE_KEY_INVALID")
    machine = CodingMachine.objects.select_related("workspace", "owner").filter(key_hash=_hash(key)).first()
    # A removed machine has no record, so its key matches nothing.
    if machine is None or machine.workspace.deleted_at is not None:
        raise MachineAuthError(
            "This machine key is not valid. The machine may have been removed.", code="MACHINE_UNKNOWN"
        )
    if machine.state == MachineState.REVOKED:
        raise MachineAuthError("This machine was revoked by a workspace admin.", code="MACHINE_REVOKED")
    if not owner_may_use_machines(machine.owner, machine.workspace):
        raise MachineOwnerNotAllowed("The machine's owner can no longer run coding jobs in this workspace.")
    return machine


def heartbeat(machine: CodingMachine, report: dict) -> CodingMachine:
    """Record that the machine is connected, and what it reported."""
    fields = {"last_seen_at": timezone.now(), "updated_at": timezone.now()}
    if report:
        fields["capabilities"] = report.get("capabilities", {})
        for field in ("hostname", "os", "version"):
            if field in report:
                fields[field] = report[field]
    # An update, not save(): a revoke or removal that landed meanwhile must not be written back.
    CodingMachine.objects.filter(pk=machine.pk).update(**fields)
    for field, value in fields.items():
        setattr(machine, field, value)
    return machine


def approve(machine: CodingMachine) -> CodingMachine:
    with transaction.atomic():
        machine = CodingMachine.objects.select_for_update().get(pk=machine.pk)
        if machine.state == MachineState.ACTIVE:
            return machine
        if machine.state == MachineState.REVOKED:
            raise Conflict("A revoked machine cannot be approved.", code="MACHINE_REVOKED")
        if machine.state != MachineState.AWAITING_APPROVAL:
            raise Conflict(
                "The machine has not joined yet: run the join command on it first.", code="MACHINE_NOT_JOINED"
            )
        machine.state = MachineState.ACTIVE
        machine.approved_at = timezone.now()
        machine.save(update_fields=["state", "approved_at", "updated_at"])
    return machine


def revoke(machine: CodingMachine, by) -> CodingMachine:
    with transaction.atomic():
        machine = CodingMachine.objects.select_for_update().get(pk=machine.pk)
        if machine.state == MachineState.REVOKED:
            return machine
        machine.state = MachineState.REVOKED
        machine.revoked_at = timezone.now()
        machine.revoked_by = by
        # The key hash stays, so the machine is told it was revoked (and stops) rather than that its key is unknown;
        # the state check refuses it either way. A join code that was never used dies here.
        machine.join_code_hash = None
        machine.save(update_fields=["state", "revoked_at", "revoked_by", "join_code_hash", "updated_at"])
    return machine


def remove(machine: CodingMachine) -> None:
    """Delete the record and its key hash for good. Jobs that asked for it keep running on Auto."""
    machine.delete(soft=False)


def available_machine(machine_id, workspace, user) -> CodingMachine:
    """The machine a job may ask for: the requester's own, approved and not revoked. It need not be online now: the
    job waits in the queue until it is."""
    machine = CodingMachine.objects.filter(
        pk=machine_id, workspace=workspace, owner=user, state=MachineState.ACTIVE
    ).first()
    if machine is None:
        raise CodingError(
            "That machine is not one of your approved machines in this workspace.", code="MACHINE_NOT_AVAILABLE"
        )
    return machine
