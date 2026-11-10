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

Messages name their agent by slug (`Message.sender_agent`). The name shown is the registry's, also while the agent is
disabled; once it is deleted from the registry its messages show as from a removed agent.
"""

from plane.app.permissions.base import ROLE
from plane.license.models import (
    AGENT_PERMISSION_LEVEL_ORDER,
    AgentDefinition,
    agent_permission_rank,
)

# What notifications and emails call an agent the registry no longer has. The web app has its own translations.
REMOVED_AGENT_NAME = "Removed agent"


def can_add_agents(role):
    """Workspace admins and members may run agents, so they may add them; guests may not."""
    return role is not None and role >= ROLE.MEMBER.value


def available_agent(agent_id):
    """The registry's agent with this ID if it is enabled, which is what makes it available to every workspace."""
    return AgentDefinition.objects.filter(pk=agent_id, is_enabled=True).first()


def can_grant(agent, level):
    """Whether `level` is one of the agent's levels the registry allows: at most its maximum."""
    return level in AGENT_PERMISSION_LEVEL_ORDER and agent_permission_rank(level) <= agent_permission_rank(
        agent.max_permission_level
    )


def effective_permission_level(channel_agent):
    """The level the agent works at in the channel: as chosen, unless the registry's maximum has come down since."""
    chosen, maximum = channel_agent.permission_level, channel_agent.agent.max_permission_level
    return chosen if agent_permission_rank(chosen) <= agent_permission_rank(maximum) else maximum


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
