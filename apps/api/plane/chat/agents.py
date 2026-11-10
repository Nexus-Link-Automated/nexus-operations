# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Agents in Nexus Messages: which ones a channel may have, and what to call the agent behind a message.

The agent registry is instance-wide (`plane.license.models.AgentDefinition`): an instance admin adds agents and
enables or disables each one for every workspace at once. There is no per-workspace switch, so an agent is available
to a workspace exactly when it is enabled, the rule `WorkspaceAgentsEndpoint` and the bridge's session endpoint
already apply. Who may add one mirrors who may run one (`agent_session._may_use_agents`): admins and members, never
guests. A channel admin also needs that, so a guest made admin of a channel can't add one either.

The registry gives each agent a default and a maximum permission level (ACP session modes). Anyone allowed to run the
agent may pick any level up to its maximum when starting a session, and the bridge clamps to the maximum; adding an
agent to a channel offers the same choice, and the level is clamped again whenever it is read.

In a public or private channel the level is also capped at "ask for writes" (`CHANNEL_MAX_PERMISSION_LEVEL`). Nobody
can answer a permission prompt there yet, so each one is refused, and the agent's context holds other members'
messages, which must not be able to steer what it changes with the asker's rights unasked.

Messages name their agent by slug (`Message.sender_agent`). The name shown is the registry's, also while the agent is
disabled; once it is deleted from the registry its messages show as from a removed agent.
"""

from plane.app.permissions.base import ROLE
from plane.chat.models.channel import NAMED_KINDS
from plane.license.models import (
    AGENT_PERMISSION_LEVEL_ORDER,
    AgentDefinition,
    AgentPermissionLevel,
    agent_permission_rank,
)

# The most an agent may do in a public or private channel, whatever the registry allows (see the module docstring).
CHANNEL_MAX_PERMISSION_LEVEL = AgentPermissionLevel.ASK_WRITES.value

# What notifications and emails call an agent the registry no longer has. The web app has its own translations.
REMOVED_AGENT_NAME = "Removed agent"


def can_add_agents(role):
    """Workspace admins and members may run agents, so they may add them; guests may not."""
    return role is not None and role >= ROLE.MEMBER.value


def available_agent(agent_id):
    """The registry's agent with this ID if it is enabled, which is what makes it available to every workspace."""
    return AgentDefinition.objects.filter(pk=agent_id, is_enabled=True).first()


def _lower(first, second):
    return first if agent_permission_rank(first) <= agent_permission_rank(second) else second


def max_permission_level(agent, channel=None):
    """The highest level `agent` may work at: the registry's maximum, capped in a public or private `channel`."""
    maximum = agent.max_permission_level
    if channel is not None and channel.kind in NAMED_KINDS:
        return _lower(maximum, CHANNEL_MAX_PERMISSION_LEVEL)
    return maximum


def default_permission_level(agent, channel=None):
    """The level `agent` starts at when none is chosen: the registry's default, capped by `max_permission_level`."""
    return _lower(agent.default_permission_level, max_permission_level(agent, channel))


def can_grant(agent, level, channel=None):
    """Whether `agent` may be given `level` (in `channel`, if one is given): at most its maximum there."""
    return level in AGENT_PERMISSION_LEVEL_ORDER and agent_permission_rank(level) <= agent_permission_rank(
        max_permission_level(agent, channel)
    )


def effective_permission_level(channel_agent):
    """The level the agent works at in the channel: as chosen, unless its maximum there is lower.

    Clamped when read, so a lower registry maximum, or the channel cap, applies to agents added before it.
    """
    return _lower(channel_agent.permission_level, max_permission_level(channel_agent.agent, channel_agent.channel))


def agents_by_slug(slugs):
    """The registry's agents among `slugs`, by slug, enabled or not. A slug missing from it is a removed agent."""
    slugs = {slug for slug in slugs if slug}
    if not slugs:
        return {}
    return {agent.slug: agent for agent in AgentDefinition.objects.filter(slug__in=slugs)}


def agent_display_name(slug, agents=None):
    """What to call the agent with this slug in a notification or an email. `agents` is from `agents_by_slug`."""
    agent = (agents if agents is not None else agents_by_slug([slug])).get(slug)
    return agent.name if agent is not None else REMOVED_AGENT_NAME


def agent_details(agent):
    """What a reader is shown of an agent: never its configuration."""
    if agent is None:
        return None
    return {
        "id": str(agent.id),
        "slug": agent.slug,
        "name": agent.name,
        "adapter": agent.adapter,
        "is_available": agent.is_enabled,
    }
