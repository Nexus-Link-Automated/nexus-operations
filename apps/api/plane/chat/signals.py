# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Keep chat access in step with Plane's workspace membership and the agent registry.

Connected in `ChatConfig.ready()`.
"""

from django.db import transaction
from django.db.models import OuterRef, Subquery
from django.db.models.signals import post_save, pre_delete, pre_save
from django.dispatch import receiver
from django.utils import timezone

from plane.app.permissions.base import ROLE
from plane.chat.events import EventType, access_revoked_event, agent_member_event, member_event, publish_on_commit
from plane.chat.models import ChannelAgent, ChannelKind, ChannelMember, ChannelMemberRole, ChatGuestPermission
from plane.chat.models.channel import NAMED_KINDS
from plane.chat.permissions import lock_channel_admins, lock_member
from plane.db.models import User, WorkspaceMember
from plane.license.models import AgentDefinition

# The columns whose change can end someone's time as a guest or in the workspace.
_MEMBERSHIP_FIELDS = {"role", "is_active", "deleted_at"}


def _revoke_guest_grants(**scope):
    ChatGuestPermission.objects.filter(can_open_dms=True, **scope).update(can_open_dms=False, updated_at=timezone.now())


def _end_seat(member):
    """End one channel membership, and say whether this call did it: a request may be ending it at the same moment."""
    return bool(ChannelMember.objects.filter(pk=member.pk).delete())


def _successor(leaving):
    """Who takes over, locked: the longest-standing member still in the workspace, and a guest only as a last resort.

    Locked because they may be leaving too; anyone who has just gone is passed over.
    """
    workspace_role = WorkspaceMember.objects.filter(
        workspace_id=OuterRef("workspace_id"), member_id=OuterRef("user_id"), is_active=True
    ).values("role")[:1]
    remaining = (
        ChannelMember.objects.filter(channel_id=leaving.channel_id)
        .exclude(pk=leaving.pk)
        .annotate(workspace_role=Subquery(workspace_role))
        .filter(workspace_role__isnull=False)
        .order_by("created_at", "id")
    )
    # `sorted` keeps equals in order, and the rows are oldest first.
    for candidate in sorted(remaining, key=lambda member: member.workspace_role < ROLE.MEMBER.value):
        successor = lock_member(candidate)
        if successor is not None:
            return successor
    return None


def _hand_over_private_channels(**scope):
    """A private channel keeps an admin: workspace admins can't see one they aren't in, so can't step in.

    Returns the events to publish.
    """
    events = []
    leaving_admins = ChannelMember.objects.filter(
        channel__kind=ChannelKind.PRIVATE, role=ChannelMemberRole.ADMIN, **scope
    )
    for leaving in leaving_admins:
        with transaction.atomic():
            # Giving up the seat inside the lock means two admins leaving at once can't each rely on the other.
            if lock_channel_admins(leaving.channel_id) == [leaving.pk]:
                successor = _successor(leaving)
                if successor is not None:
                    successor.role = ChannelMemberRole.ADMIN
                    successor.save(update_fields=["role", "updated_at", "updated_by"])
                    events.append(member_event(EventType.MEMBER_UPDATED, successor))
            if _end_seat(leaving):
                events.append(member_event(EventType.MEMBER_REMOVED, leaving))
    return events


def _end_channel_memberships(**scope):
    """Being invited back must not reopen private channels, as with Plane's project memberships.

    DMs and group DMs stay: their membership is fixed, and they are that person's own conversations.
    Returns the events to publish, so a departure goes out as one batch over one connection: if Redis has
    stopped answering, that costs the request one timeout rather than one per channel.
    """
    events = _hand_over_private_channels(**scope)
    with transaction.atomic():
        seats = ChannelMember.objects.filter(channel__kind__in=NAMED_KINDS, **scope)
        events += [member_event(EventType.MEMBER_REMOVED, seat) for seat in seats if _end_seat(seat)]
    return events


@receiver(pre_save, sender=WorkspaceMember, dispatch_uid="chat_note_leaving_workspace")
@receiver(pre_save, sender=User, dispatch_uid="chat_note_deactivating_account")
def note_access_ending(sender, instance, **kwargs):
    """Whether this save is the one that ends someone's access; `post_save` can only see the new state.

    Costs a query only when the row being saved is already out, which is rare.
    """
    ending = not instance.is_active or getattr(instance, "deleted_at", None) is not None
    instance._chat_access_ending = ending and sender.objects.filter(pk=instance.pk, is_active=True).exists()


@receiver(post_save, sender=WorkspaceMember, dispatch_uid="chat_workspace_membership_changed")
def workspace_membership_changed(sender, instance, update_fields=None, **kwargs):
    """Leaving the workspace ends channel memberships; a guest's DM grant ends when they stop being an active guest.

    So demoting someone back to guest, or inviting them again, starts with no DM access until an
    admin grants it again. Plane's bulk `.update()` when an invite is re-accepted only brings people back,
    so skipping signals there is harmless; deactivating an account is handled by `account_deactivated`.
    """
    if update_fields is not None and not _MEMBERSHIP_FIELDS.intersection(update_fields):
        return
    scope = {"workspace_id": instance.workspace_id, "user_id": instance.member_id}
    if not instance.is_active or instance.deleted_at is not None:
        events = _end_channel_memberships(**scope)
        _revoke_guest_grants(**scope)
        if getattr(instance, "_chat_access_ending", False):
            events.append(access_revoked_event(instance.workspace_id, instance.member_id))
        publish_on_commit(*events)
    elif instance.role >= ROLE.MEMBER.value:
        _revoke_guest_grants(**scope)


@receiver(post_save, sender=User, dispatch_uid="chat_account_deactivated")
def account_deactivated(sender, instance, update_fields=None, **kwargs):
    """Deactivating an account leaves every workspace, but through `bulk_update`, which sends no signal."""
    if instance.is_active or (update_fields is not None and "is_active" not in update_fields):
        return
    events = _end_channel_memberships(user_id=instance.pk)
    _revoke_guest_grants(user_id=instance.pk)
    if getattr(instance, "_chat_access_ending", False):
        # Left active or not, as `deactivate` has already switched these off by the time the account is saved.
        workspaces = WorkspaceMember.objects.filter(member_id=instance.pk).values_list("workspace_id", flat=True)
        events += [access_revoked_event(workspace_id, instance.pk) for workspace_id in workspaces]
    publish_on_commit(*events)


def _agent_seats(agent):
    """The agent's places in channels people can still open."""
    return ChannelAgent.objects.filter(agent=agent, channel__deleted_at__isnull=True)


@receiver(pre_save, sender=AgentDefinition, dispatch_uid="chat_note_agent_availability")
def note_agent_availability(sender, instance, **kwargs):
    """Whether the agent was enabled before this save, or None for a new one."""
    previous = None
    if not instance._state.adding:
        previous = sender.objects.filter(pk=instance.pk).values_list("is_enabled", flat=True).first()
    instance._chat_was_enabled = previous


@receiver(post_save, sender=AgentDefinition, dispatch_uid="chat_agent_availability_changed")
def agent_availability_changed(sender, instance, **kwargs):
    """Disabling an agent takes it out of its channels for open clients, and enabling it brings it back.

    The rows stay either way: a disabled agent is listed as unavailable, and nothing reaches it.
    """
    previous = getattr(instance, "_chat_was_enabled", None)
    if previous is None or previous == instance.is_enabled:
        return
    event_type = EventType.MEMBER_ADDED if instance.is_enabled else EventType.MEMBER_REMOVED
    publish_on_commit(*[agent_member_event(event_type, seat) for seat in _agent_seats(instance)])


@receiver(pre_delete, sender=AgentDefinition, dispatch_uid="chat_agent_deleted")
def agent_deleted(sender, instance, **kwargs):
    """Deleting an agent from the registry deletes its places in channels with it (the foreign key cascades).

    Its messages stay and show as from a removed agent. A disabled agent has already been announced as gone.
    """
    if instance.is_enabled:
        publish_on_commit(*[agent_member_event(EventType.MEMBER_REMOVED, seat) for seat in _agent_seats(instance)])
