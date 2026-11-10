# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Per-user rate limits on chat writes and on search.

Each limit (`settings.CHAT_RATE_LIMITS`) is one or more DRF rates, and every one of them applies: a short window lets
a fast typist or a burst of pasted messages through, and a long one stops a script that keeps under the short one.
Going over one answers 429 with `Retry-After`. The counts live in the shared cache, so every API worker sees them.

Every chat endpoint needs a signed-in session, so the limits are by user, not by IP address: people behind one NAT or
proxy don't share a budget. Automatic posts (`project_feed`) and digests (`digest`) are Celery tasks, not requests,
so nothing here counts them.
"""

from django.conf import settings
from rest_framework.throttling import SimpleRateThrottle


class ChatRateThrottle(SimpleRateThrottle):
    def __init__(self, name, rate):
        self.name = name
        self.rate = rate
        super().__init__()

    def get_cache_key(self, request, view):
        if not request.user or not request.user.is_authenticated:
            return None
        # The window is in the key, so a limit's short and long windows keep separate histories.
        return f"chat_throttle:{self.name}:{self.duration}:{request.user.pk}"


def chat_throttles(name):
    """One throttle per rate in the `name` limit."""
    return [ChatRateThrottle(name, rate) for rate in settings.CHAT_RATE_LIMITS[name].split(",")]
