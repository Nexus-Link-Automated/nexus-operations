# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Which bots count as members.

Plane hides its own bot users from member lists. An EmployAI bot member (`plane.coding.bot_members`) is a member like
a person: listed, given a role, added to projects and removed like anyone.
"""

from django.db.models import Q

EMPLOYAI_BOT_TYPE = "EMPLOYAI"

# A filter on a `WorkspaceMember` or `ProjectMember` queryset: people and EmployAI bot members.
PEOPLE_AND_BOT_MEMBERS = Q(member__is_bot=False) | Q(member__bot_type=EMPLOYAI_BOT_TYPE)
