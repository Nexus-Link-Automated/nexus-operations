# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Real Redis and real threads for the chat event tests, shared by the unit and contract suites."""

import contextlib
import json
import threading
from unittest import mock
from uuid import uuid4

from django.db import connection

from plane.settings.redis import redis_instance

_MARKER_CHANNEL = "chat:workspace:test-marker"


class Published:
    """What really reached Redis: a live subscriber to every workspace's chat events."""

    def __init__(self):
        self._client = redis_instance()
        self._pubsub = self._client.pubsub()
        self._pubsub.psubscribe("chat:workspace:*")
        assert self._pubsub.get_message(timeout=5)["type"] == "psubscribe"
        self.received = []  # (pub/sub channel, decoded event)

    def _drain(self):
        """Read everything published so far.

        Redis handles commands one at a time and delivers in that order, so once a marker sent now
        comes back, nothing published before it is still on its way. No test has to sleep or guess.
        """
        marker = uuid4().hex
        self._client.publish(_MARKER_CHANNEL, marker)
        while True:
            message = self._pubsub.get_message(timeout=5)
            assert message is not None, "the marker never came back"
            if message["type"] != "pmessage":
                continue
            if message["data"].decode() == marker:
                return
            self.received.append((message["channel"].decode(), json.loads(message["data"])))

    @property
    def raw(self):
        """Every event so far, exactly as published."""
        self._drain()
        return [event for _, event in self.received]

    @property
    def events(self):
        """Every event so far, without its timestamp (which tests can't predict)."""
        return [{key: value for key, value in event.items() if key != "at"} for event in self.raw]

    @property
    def pubsub_channels(self):
        self._drain()
        return [channel for channel, _ in self.received]

    def clear(self):
        self._drain()
        self.received.clear()

    def close(self):
        self._pubsub.close()
        self._client.close()


def run_together(*calls, timeout=30):
    """Run `calls` at once on real threads, each on its own database connection. Returns their results in order."""
    results = [None] * len(calls)
    errors = []

    def run(index, call):
        try:
            results[index] = call()
        except Exception as error:
            errors.append(error)
        finally:
            connection.close()

    threads = [threading.Thread(target=run, args=(i, call), daemon=True) for i, call in enumerate(calls)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout)
    assert not any(thread.is_alive() for thread in threads), "a thread never finished"
    assert not errors, errors
    return results


@contextlib.contextmanager
def overlap_at(*targets, parties=2, wait=1):
    """Hold callers of each `(owner, attribute)` until `parties` have arrived, or for `wait` seconds.

    Placed between a check and its write, this forces two requests to both pass the check. Where a lock
    is doing its job the other request can't get here, so the wait runs out and the holder carries on.
    """
    barrier = threading.Barrier(parties)

    def holding(real):
        def held(*args, **kwargs):
            with contextlib.suppress(threading.BrokenBarrierError):
                barrier.wait(timeout=wait)
            return real(*args, **kwargs)

        return held

    patches = [mock.patch.object(owner, name, holding(getattr(owner, name))) for owner, name in targets]
    for patch in patches:
        patch.start()
    try:
        yield
    finally:
        for patch in patches:
            patch.stop()
