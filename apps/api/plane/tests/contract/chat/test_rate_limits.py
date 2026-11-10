# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Per-user rate limits on chat writes and searches (`plane.chat.throttles`)."""

import pytest

from plane.chat.models import Message
from plane.db.models import Issue, Project, ProjectMember
from plane.settings.common import _CHAT_RATE_LIMIT_DEFAULTS, _chat_rate_limits

MEMBER = 15


def _limits(**overrides):
    """Every limit far out of reach, but those given."""
    return {name: "1000/minute" for name in _CHAT_RATE_LIMIT_DEFAULTS} | overrides


@pytest.fixture
def channel(make_channel, member, member2):
    return make_channel(members=[member.user, member2.user])


@pytest.fixture
def limits(settings):
    def set_limits(**overrides):
        settings.CHAT_RATE_LIMITS = _limits(**overrides)

    return set_limits


def _post_message(actor, channel, url, text="hi", parent=None):
    body = {"body_html": f"<p>{text}</p>", **({"parent_id": str(parent.id)} if parent else {})}
    return actor.client.post(url(f"channels/{channel.id}/messages/"), body, format="json")


@pytest.mark.contract
class TestSending:
    def test_over_the_limit_is_429_with_retry_after(self, member, channel, url, limits):
        limits(send="3/minute")
        for _ in range(3):
            assert _post_message(member, channel, url).status_code == 201
        refused = _post_message(member, channel, url, "one too many")
        assert refused.status_code == 429
        assert 0 < int(refused["Retry-After"]) <= 60
        assert refused.data == {
            "error": "Too many requests. Wait a moment and try again.",
            "retry_after": int(refused["Retry-After"]),
        }
        assert not Message.objects.filter(body_html="<p>one too many</p>").exists()

    def test_replies_count_with_messages(self, member, channel, url, limits, send):
        limits(send="2/minute")
        parent = send(channel, member.user)
        assert _post_message(member, channel, url).status_code == 201
        assert _post_message(member, channel, url, parent=parent).status_code == 201
        assert _post_message(member, channel, url, parent=parent).status_code == 429

    def test_each_person_has_their_own_budget(self, member, member2, channel, url, limits):
        limits(send="1/minute")
        assert _post_message(member, channel, url).status_code == 201
        assert _post_message(member, channel, url).status_code == 429
        assert _post_message(member2, channel, url).status_code == 201

    def test_the_long_window_applies_as_well_as_the_short(self, member, channel, url, limits):
        limits(send="5/minute,2/hour")
        assert _post_message(member, channel, url).status_code == 201
        assert _post_message(member, channel, url).status_code == 201
        refused = _post_message(member, channel, url)
        assert refused.status_code == 429
        assert 60 < int(refused["Retry-After"]) <= 3600

    def test_reading_is_not_limited(self, member, channel, url, limits, send):
        limits(send="1/minute")
        send(channel, member.user)
        assert _post_message(member, channel, url).status_code == 201
        for _ in range(5):
            assert member.client.get(url(f"channels/{channel.id}/messages/")).status_code == 200

    def test_other_limits_dont_spend_this_one(self, member, channel, url, limits, send):
        limits(send="1/minute", edit="1/minute")
        message = send(channel, member.user)
        edited = member.client.patch(
            url(f"channels/{channel.id}/messages/{message.id}/"), {"body_html": "<p>edited</p>"}, format="json"
        )
        assert edited.status_code == 200
        assert _post_message(member, channel, url).status_code == 201


@pytest.mark.contract
class TestEachLimitedEndpoint:
    def test_edit_and_remove_share_a_limit(self, member, channel, url, limits, send):
        limits(edit="2/minute")
        first, second = send(channel, member.user), send(channel, member.user)
        message_url = url(f"channels/{channel.id}/messages/{first.id}/")
        assert member.client.patch(message_url, {"body_html": "<p>edited</p>"}, format="json").status_code == 200
        assert member.client.delete(message_url).status_code == 204
        assert member.client.delete(url(f"channels/{channel.id}/messages/{second.id}/")).status_code == 429
        assert Message.objects.get(pk=second.pk).removed_at is None

    def test_upload_slots(self, member, channel, url, limits, monkeypatch):
        for key, value in {"AWS_ACCESS_KEY_ID": "k", "AWS_SECRET_ACCESS_KEY": "s", "AWS_S3_BUCKET_NAME": "b"}.items():
            monkeypatch.setenv(key, value)
        limits(upload="1/minute")
        slot = {"name": "a.png", "type": "image/png", "size": 10}
        first = member.client.post(url(f"channels/{channel.id}/attachments/"), slot, format="json")
        assert first.status_code == 201
        again = member.client.post(url(f"channels/{channel.id}/attachments/"), slot, format="json")
        assert again.status_code == 429

    def test_creating_channels_and_opening_dms_share_a_limit(self, member, member2, url, limits):
        limits(channel="2/minute")
        assert member.client.post(url("channels/"), {"name": "one", "kind": "public"}, format="json").status_code == 201
        opened = member.client.post(url("dms/"), {"member_ids": [str(member2.user.id)]}, format="json")
        assert opened.status_code in (200, 201)
        assert member.client.post(url("channels/"), {"name": "two", "kind": "public"}, format="json").status_code == 429

    def test_search(self, member, url, limits):
        limits(search="2/minute")
        for _ in range(2):
            assert member.client.get(url("search/"), {"q": "hello"}).status_code == 200
        assert member.client.get(url("search/"), {"q": "hello"}).status_code == 429

    def test_marking_read(self, member, channel, url, limits, send):
        limits(read="1/minute")
        message = send(channel, member.user)
        read_url = url(f"channels/{channel.id}/read/")
        assert member.client.post(read_url, {"message_id": str(message.id)}, format="json").status_code == 200
        assert member.client.post(read_url, {"message_id": str(message.id)}, format="json").status_code == 429

    def test_linking_a_work_item_and_its_note_doesnt_spend_sending(self, member, channel, workspace, url, limits, send):
        limits(work_item="1/minute", send="1/minute")
        project = Project.objects.create(name="Ops", identifier="OPS", workspace=workspace)
        ProjectMember.objects.create(project=project, workspace=workspace, member=member.user, role=MEMBER)
        issue = Issue.objects.create(name="Broken", workspace=workspace, project=project)
        message = send(channel, member.user)
        link_url = url(f"channels/{channel.id}/messages/{message.id}/work-items/")
        assert member.client.post(link_url, {"issue_id": str(issue.id)}, format="json").status_code == 201
        assert member.client.post(link_url, {"issue_id": str(issue.id)}, format="json").status_code == 429
        # The note it posted in the thread was not a message the caller sent.
        assert _post_message(member, channel, url).status_code == 201


@pytest.mark.unit
class TestConfiguration:
    def test_defaults(self):
        assert _chat_rate_limits({}) == _CHAT_RATE_LIMIT_DEFAULTS

    def test_the_defaults_let_a_burst_through(self):
        burst, *_ = _CHAT_RATE_LIMIT_DEFAULTS["send"].split(",")
        assert int(burst.split("/")[0]) >= 20

    def test_an_environment_variable_overrides_one(self):
        limits = _chat_rate_limits({"CHAT_RATE_LIMIT_SEND": "10/second, 100/day"})
        assert limits["send"] == "10/second,100/day"
        assert limits["search"] == _CHAT_RATE_LIMIT_DEFAULTS["search"]

    @pytest.mark.parametrize("raw", ["fast", "0/minute", "10/fortnight", "10/minute,", "-1/minute", "1/minute;2/hour"])
    def test_an_invalid_value_keeps_the_default(self, raw):
        assert _chat_rate_limits({"CHAT_RATE_LIMIT_SEND": raw})["send"] == _CHAT_RATE_LIMIT_DEFAULTS["send"]
