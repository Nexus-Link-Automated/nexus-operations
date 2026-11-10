# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""The database keeps agents out of DMs and group DMs, whatever writes the row."""

import importlib
import uuid

import pytest
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from plane.chat.models import Channel, ChannelKind
from plane.license.models import AgentDefinition

migration = importlib.import_module("plane.chat.migrations.0009_channel_agent")


@pytest.fixture
def trigger(db):
    """The migration's trigger. The test database is built from the models, without running migrations."""
    with connection.cursor() as cursor:
        cursor.execute(migration.CREATE_NO_AGENTS_IN_DMS)
    yield
    with connection.cursor() as cursor:
        cursor.execute(migration.DROP_NO_AGENTS_IN_DMS)


def _insert(channel, agent):
    """A row written straight to the table, past the model's own check."""
    now = timezone.now()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO chat_channel_agents (id, created_at, updated_at, workspace_id, channel_id, agent_id,"
            " permission_level) VALUES (%s, %s, %s, %s, %s, %s, 'ask_all')",
            [uuid.uuid4(), now, now, channel.workspace_id, channel.id, agent.id],
        )


@pytest.mark.unit
class TestNoAgentsInDirectMessages:
    def test_a_dm_or_group_dm_row_is_refused(self, trigger, workspace, make_member):
        agent = AgentDefinition.objects.create(name="Bot", slug="bot", adapter="claude")
        a, b, c = make_member(), make_member(), make_member()
        dm = Channel.objects.get_or_create_dm(workspace, a, b)[0]
        group = Channel.objects.get_or_create_group_dm(workspace, [a, b, c])[0]
        for channel in (dm, group):
            with pytest.raises(IntegrityError), transaction.atomic():
                _insert(channel, agent)

    def test_public_and_private_channels_are_fine(self, trigger, workspace):
        agent = AgentDefinition.objects.create(name="Bot", slug="bot", adapter="claude")
        for kind in (ChannelKind.PUBLIC, ChannelKind.PRIVATE):
            _insert(Channel.objects.create(workspace=workspace, kind=kind, name=f"c-{kind}"), agent)

    def test_moving_a_row_into_a_dm_is_refused(self, trigger, workspace, make_member):
        agent = AgentDefinition.objects.create(name="Bot", slug="bot", adapter="claude")
        public = Channel.objects.create(workspace=workspace, kind=ChannelKind.PUBLIC, name="general")
        dm = Channel.objects.get_or_create_dm(workspace, make_member(), make_member())[0]
        _insert(public, agent)
        with pytest.raises(IntegrityError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("UPDATE chat_channel_agents SET channel_id = %s", [dm.id])
