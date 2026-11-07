# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A stand-in for the Redis client chat events are published with, shared by the chat unit and contract tests."""

import json


class FakeRedis:
    """Records `PUBLISH`es instead of sending them. Set `error` to make every publish fail with it."""

    def __init__(self):
        self.published = []  # (pub/sub channel, decoded event)
        self.closed = 0
        self.error = None

    def publish(self, channel, payload):
        if self.error is not None:
            raise self.error
        self.published.append((channel, json.loads(payload)))
        return 0

    def close(self):
        self.closed += 1

    @property
    def events(self):
        """The events published, without their timestamp (which tests can't predict)."""
        return [{key: value for key, value in event.items() if key != "at"} for _, event in self.published]
