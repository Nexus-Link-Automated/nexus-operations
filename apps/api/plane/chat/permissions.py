# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Who may see and change what in Nexus Messages.

Workspace membership is checked first, by the view's permission class: someone who
is not an active member of the workspace gets 403, as everywhere in plane.app.

Below that, a channel the caller cannot see is a 404, never a 403, so a private
channel's or a DM's existence does not leak:

- workspace members and admins see every public channel in the workspace;
- everyone sees the channels and DMs they are a member of;
- guests see nothing else.

Seeing a channel lets you read its messages and members. Writing to it (sending,
editing or removing your own messages, marking as read, adding members) needs
channel membership, which is a 403 for a public channel you can see but have not
joined. Moderation (renaming, archiving, removing other people's messages or
members) needs a channel admin or a workspace admin, who need not be in a public
channel to moderate it. A private channel's last admin can't step down while others
remain in it; if they leave the workspace, someone still in it takes over (see
`plane.chat.signals`). DMs and group DMs have no moderators: only a message's sender
can remove it.

Opening a DM or group DM needs a workspace member or admin, or a guest a workspace
admin has granted it to (`ChatGuestPermission`).

Agents from the registry can be members of public and private channels, never of DMs or
group DMs (`plane.chat.agents`). Adding one needs a channel admin or a workspace admin who
may also run agents, so never a guest. Removing one needs a channel admin or a workspace
admin, as removing anyone else does: whoever added it gets no say of their own.

Linking a public or private channel to a project (`can_link_project`) needs a channel
admin or a workspace admin who is also a member or admin of that project. Unlinking
needs only the channel admin: it stops the posts and shows nobody anything.
"""

from django.db.models import Exists, OuterRef, Q

from plane.app.permissions.base import ROLE
from plane.chat.agents import can_add_agents
from plane.chat.exceptions import Conflict, Forbidden, NotFound
from plane.chat.models import Channel, ChannelKind, ChannelMember, ChannelMemberRole, ChatGuestPermission
from plane.db.models import ProjectMember, WorkspaceMember


def workspace_role(user, slug):
    """The caller's role in the workspace, or None if they are not an active member."""
    return (
        WorkspaceMember.objects.filter(workspace__slug=slug, member=user, is_active=True)
        .values_list("role", flat=True)
        .first()
    )


def can_browse_public_channels(role):
    """Members and admins see every public channel; guests only the channels they were added to."""
    return role is not None and role >= ROLE.MEMBER.value


def can_create_channels(role):
    return role is not None and role >= ROLE.MEMBER.value


def is_workspace_admin(role):
    return role == ROLE.ADMIN.value


def visible_channels(user, slug, role):
    """Channels in the workspace `slug` the caller can see, annotated with `is_member`."""
    queryset = Channel.objects.filter(workspace__slug=slug).annotate(
        is_member=Exists(ChannelMember.objects.filter(channel=OuterRef("pk"), user=user))
    )
    visible = Q(is_member=True)
    if can_browse_public_channels(role):
        visible |= Q(kind=ChannelKind.PUBLIC)
    return queryset.filter(visible)


def get_visible_channel(user, slug, role, channel_id):
    """The channel, with the caller's `membership` (or None) attached; 404 if they cannot see it."""
    channel = visible_channels(user, slug, role).filter(pk=channel_id).first()
    if channel is None:
        raise NotFound("Channel not found.")
    channel.membership = ChannelMember.objects.filter(channel=channel, user=user).first()
    return channel


def require_channel_member(channel):
    """Writes need membership. Only a public channel is visible without it, so this is never a leak."""
    if channel.membership is None:
        raise Forbidden("Join the channel first.")
    return channel.membership


def is_channel_admin(channel, role):
    """A channel admin, or a workspace admin who can see the channel. Nobody is one in a DM or group DM."""
    if channel.is_direct:
        return False
    membership = channel.membership
    return is_workspace_admin(role) or (membership is not None and membership.role == ChannelMemberRole.ADMIN)


def require_channel_admin(channel, role):
    if not is_channel_admin(channel, role):
        raise Forbidden("Only a channel admin or a workspace admin can do this.")


def require_can_add_agents(channel, role):
    """Adding an agent: a channel admin or workspace admin who may run agents in the workspace."""
    if not can_add_agents(role):
        raise Forbidden("Guests can't add agents.")
    require_channel_admin(channel, role)


def require_not_archived(channel):
    """Archived channels are read-only."""
    if channel.archived_at is not None:
        raise Conflict("The channel is archived.")


def lock_channel_admins(channel_id):
    """The channel's admin rows' IDs, locked until the transaction ends, so admins leaving at once are taken in turn."""
    return list(
        ChannelMember.objects.select_for_update()
        .filter(channel_id=channel_id, role=ChannelMemberRole.ADMIN)
        .values_list("pk", flat=True)
    )


def lock_member(member):
    """`member`'s row, locked until the transaction ends, or None if they have left since it was read."""
    return ChannelMember.objects.select_for_update().filter(pk=member.pk).first()


def lock_member_keeping_an_admin(channel, member):
    """`member`'s row, locked, for taking away any admin role they hold; None if they have left.

    A private channel keeps a channel admin while anyone else is in it: workspace admins can't see
    one they aren't in, so without one nobody could rename or archive it. Refuses (409) leaving,
    removal or demotion when they are the last admin and someone else remains. Call it inside the
    transaction that makes the change.

    The admin rows are locked first, the order every path uses, so admins leaving at once wait for
    each other instead of deadlocking. The decision is a fresh query made once the locks are held:
    `member` may be out of date, and so may the locking query, which can't see anyone promoted while
    it was waiting.
    """
    if channel.kind != ChannelKind.PRIVATE:
        return lock_member(member)
    lock_channel_admins(channel.id)
    current = lock_member(member)
    if current is not None and current.role == ChannelMemberRole.ADMIN:
        others = ChannelMember.objects.filter(channel=channel).exclude(pk=current.pk)
        if others.exists() and not others.filter(role=ChannelMemberRole.ADMIN).exists():
            raise Conflict("Make someone else a channel admin first; a private channel needs one.")
    return current


def can_open_dms(user, workspace_id, role):
    """Members and admins can always open DMs; a guest only with a workspace admin's grant."""
    if role is not None and role >= ROLE.MEMBER.value:
        return True
    return (
        role is not None
        and ChatGuestPermission.objects.filter(workspace_id=workspace_id, user=user, can_open_dms=True).exists()
    )


def can_link_project(user, project, workspace_id):
    """Whether `user` may link a channel to `project`, whose state changes everyone reading the channel will see.

    Only someone who sees all of the project's work items can make that call: an active member or admin of
    the project. Project guests can't, as Plane shows them only part of the project. Archived projects can't
    be linked, since nothing is posted for them.
    """
    return (
        project.workspace_id == workspace_id
        and project.archived_at is None
        and ProjectMember.objects.filter(
            project=project, member=user, is_active=True, role__gte=ROLE.MEMBER.value
        ).exists()
    )


def require_named_channel(channel, message):
    """DMs and group DMs have no name, no roles, and a membership fixed at creation."""
    if channel.is_direct:
        raise Conflict(message)
