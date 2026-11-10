# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""search/: full-text search over the messages a reader may read, and nothing else."""

import random
from datetime import timedelta
from uuid import uuid4

import pytest
from crum import impersonate
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from plane.chat.models import Channel, ChannelKind, ChannelMember, Message, MessageSystemEvent, plain_text
from plane.chat.search import search_messages, to_tsquery_text, with_snippet
from plane.chat.views.base import annotate_messages
from plane.db.models import FileAsset, WorkspaceMember

from .conftest import GUEST, MEMBER


@pytest.fixture
def search(url):
    """search(actor, "text", channel=...) -> the response."""

    def search(actor, q, **params):
        return actor.client.get(url("search/"), {"q": q, **params})

    return search


def _ids(response):
    assert response.status_code == 200, response.data
    return [str(row["message"]["id"]) for row in response.data["results"]]


def _found(response):
    return {str(row["message"]["id"]) for row in response.data["results"]}


@pytest.fixture
def upload():
    """A file on `message` (or not yet on one), named `name`."""

    def make(channel, user, name, on=None, is_deleted=False):
        with impersonate(user):
            return FileAsset.objects.create(
                attributes={"name": name, "type": "application/pdf", "size": 10, "channel_id": str(channel.id)},
                asset=f"{channel.workspace_id}/{uuid4().hex}",
                size=10,
                workspace_id=channel.workspace_id,
                entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT,
                entity_identifier=str(on.id) if on else None,
                is_uploaded=True,
                is_deleted=is_deleted,
            )

    return make


@pytest.mark.contract
@pytest.mark.django_db
class TestWhoFindsWhat:
    def test_a_public_channel_is_searchable_by_everyone_who_can_read_it(
        self, admin, member, member2, make_channel, send, search
    ):
        message = send(make_channel(members=[member.user]), member.user, "quarterly roadmap")
        # member2 and admin aren't in it, but members and admins may read any public channel.
        for actor in (member, member2, admin):
            assert _ids(search(actor, "roadmap")) == [str(message.id)]

    def test_a_guest_finds_only_the_channels_they_were_added_to(self, guest, member, make_channel, send, search):
        added = send(make_channel(members=[member.user, guest.user]), member.user, "launch plan")
        send(make_channel(members=[member.user]), member.user, "launch plan")
        assert _ids(search(guest, "launch")) == [str(added.id)]

    def test_a_private_channel_only_for_its_members(self, admin, member, member2, make_channel, send, search):
        message = send(make_channel(ChannelKind.PRIVATE, members=[member.user]), member.user, "salary review")
        assert _ids(search(member, "salary")) == [str(message.id)]
        # A workspace admin can moderate a public channel without joining, but can't see into a private one.
        for actor in (member2, admin):
            assert _ids(search(actor, "salary")) == []

    def test_dms_and_group_dms_only_for_their_members(
        self, admin, member, member2, make_actor, workspace, send, search
    ):
        third = make_actor(MEMBER)
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        group, _ = Channel.objects.get_or_create_group_dm(workspace, [member.user, member2.user, third.user])
        in_dm = send(dm, member.user, "secret handshake")
        in_group = send(group, member.user, "secret handshake")
        assert _found(search(member, "handshake")) == {str(in_dm.id), str(in_group.id)}
        assert _found(search(third, "handshake")) == {str(in_group.id)}
        assert _ids(search(admin, "handshake")) == []

    def test_a_guest_in_a_dm_finds_it(self, guest, member, workspace, send, search):
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, guest.user)
        message = send(dm, member.user, "contract draft")
        assert _ids(search(guest, "contract")) == [str(message.id)]

    def test_leaving_a_private_channel_ends_it(self, member, member2, make_channel, send, search):
        channel = make_channel(ChannelKind.PRIVATE, members=[member.user, member2.user])
        send(channel, member2.user, "offsite venue")
        ChannelMember.objects.get(channel=channel, user=member.user).delete()
        assert _ids(search(member, "venue")) == []

    def test_a_deleted_channel_is_not_searched(self, member, make_channel, send, search):
        channel = make_channel(members=[member.user])
        send(channel, member.user, "budget numbers")
        channel.delete()
        assert _ids(search(member, "budget")) == []

    def test_an_archived_channel_is_searched_as_it_is_read(self, member, make_channel, send, search, url):
        channel = make_channel(members=[member.user])
        message = send(channel, member.user, "retro notes")
        channel.archived_at = timezone.now()
        channel.save()
        assert member.client.get(url(f"channels/{channel.id}/messages/")).status_code == 200
        res = search(member, "retro")
        assert _ids(res) == [str(message.id)]
        assert res.data["results"][0]["channel"]["archived_at"] is not None

    def test_only_this_workspace(self, member, workspace, other_workspace, make_channel, send, search):
        WorkspaceMember.objects.create(workspace=other_workspace, member=member.user, role=MEMBER)
        here = send(make_channel(members=[member.user]), member.user, "invoice")
        send(make_channel(members=[member.user], in_workspace=other_workspace), member.user, "invoice")
        assert _ids(search(member, "invoice")) == [str(here.id)]

    def test_outside_the_workspace_is_403(self, outsider, make_actor, search):
        assert search(outsider, "anything").status_code == 403
        assert search(make_actor(role=None), "anything").status_code == 403

    def test_a_demoted_member_loses_public_channels_they_never_joined(
        self, member, member2, make_channel, send, search
    ):
        message = send(make_channel(members=[member2.user]), member2.user, "hiring plan")
        assert _ids(search(member, "hiring")) == [str(message.id)]
        WorkspaceMember.objects.filter(member=member.user).update(role=GUEST)
        assert _ids(search(member, "hiring")) == []

    @pytest.mark.parametrize("reader", ["guest", "member", "admin"])
    def test_what_the_reader_cant_see_is_never_in_a_page(
        self, reader, admin, member, guest, member2, workspace, make_channel, send, search
    ):
        """Hidden messages are left out by the query itself, so they never take a place in a page."""
        actor = {"guest": guest, "member": member, "admin": admin}[reader]
        visible = make_channel(members=[member.user, guest.user, admin.user])
        mine = [send(visible, member2.user, f"agenda {i}") for i in range(3)]
        hidden = {
            # A guest reads only the channels they were added to; nobody reads a private channel or a DM they're not in.
            "guest": make_channel(members=[member2.user]),
            "member": make_channel(ChannelKind.PRIVATE, members=[member2.user]),
            "admin": Channel.objects.get_or_create_dm(workspace, member.user, member2.user)[0],
        }[reader]
        for i in range(5):
            send(hidden, member2.user, f"agenda hidden {i}")
        res = search(actor, "agenda", limit=3)
        assert _ids(res) == [str(message.id) for message in reversed(mine)] and res.data["has_more"] is False


@pytest.mark.contract
@pytest.mark.django_db
class TestWhatMatches:
    @pytest.fixture
    def channel(self, make_channel, member):
        return make_channel(members=[member.user])

    def test_the_last_word_matches_as_a_prefix(self, member, channel, send, search):
        message = send(channel, member.user, "the deployment failed")
        assert _ids(search(member, "deploy")) == [str(message.id)]
        assert _ids(search(member, "deployment fail")) == [str(message.id)]
        # Only the last word is a prefix.
        assert _ids(search(member, "deploy failed")) == []

    def test_every_word_must_match_unless_or(self, member, channel, send, search):
        both = send(channel, member.user, "red apples")
        one = send(channel, member.user, "green apples")
        assert _ids(search(member, "red apples")) == [str(both.id)]
        assert _found(search(member, "red or green")) == {str(both.id), str(one.id)}
        assert _ids(search(member, "apples -red")) == [str(one.id)]

    def test_quotes_make_a_phrase(self, member, channel, send, search):
        phrase = send(channel, member.user, "ship it today")
        send(channel, member.user, "today we ship it")
        assert _ids(search(member, '"ship it today"')) == [str(phrase.id)]

    def test_case_and_words_in_other_scripts(self, member, channel, send, search):
        russian = send(channel, member.user, "Привет команда")
        hindi = send(channel, member.user, "नमस्ते टीम")
        english = send(channel, member.user, "Standup MOVED")
        assert _ids(search(member, "команда")) == [str(russian.id)]
        assert _ids(search(member, "नमस्ते")) == [str(hindi.id)]
        assert _ids(search(member, "moved")) == [str(english.id)]

    def test_paragraphs_and_entities_are_text(self, member, channel, search):
        message = Message.objects.create(
            channel=channel, sender=member.user, body_html="<p>first line</p><p>second&nbsp;line Q&amp;A</p>"
        )
        assert message.body_stripped == "first line\nsecond line Q&A"
        assert _ids(search(member, "line second")) == [str(message.id)]
        # Entities are decoded, not indexed as words.
        assert _ids(search(member, "nbsp")) == [] and _ids(search(member, "amp")) == []

    def test_removed_messages_never_match(self, member, channel, send, search, url):
        message = send(channel, member.user, "password is hunter2")
        assert member.client.delete(url(f"channels/{channel.id}/messages/{message.id}/")).status_code == 204
        assert _ids(search(member, "hunter2")) == [] and _ids(search(member, "password")) == []
        # Nothing of the old text is left in what the index is built from.
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT to_tsvector('simple', COALESCE(body_stripped, ''))::text FROM chat_messages WHERE id = %s",
                [message.id],
            )
            assert cursor.fetchone()[0] == ""

    def test_a_removed_message_is_left_out_even_with_text_left_in_it(self, member, channel, send, search):
        message = send(channel, member.user, "leftover text")
        Message.objects.filter(pk=message.pk).update(removed_at=timezone.now())
        assert _ids(search(member, "leftover")) == []

    def test_an_edit_is_searched_as_edited(self, member, channel, send, search, url):
        message = send(channel, member.user, "meeting on monday")
        res = member.client.patch(
            url(f"channels/{channel.id}/messages/{message.id}/"),
            {"body_html": "<p>meeting on friday</p>"},
            format="json",
        )
        assert res.status_code == 200
        assert _ids(search(member, "monday")) == []
        assert _ids(search(member, "friday")) == [str(message.id)]

    def test_replies_match_and_say_whose_thread(self, member, channel, send, search, url):
        parent = send(channel, member.user, "question")
        reply = send(channel, member.user, "the answer is caching", parent=parent)
        res = search(member, "caching")
        assert _ids(res) == [str(reply.id)] and res.data["results"][0]["message"]["parent"] == parent.id
        # A removed first message keeps its thread readable, so its replies stay searchable.
        member.client.delete(url(f"channels/{channel.id}/messages/{parent.id}/"))
        assert _ids(search(member, "caching")) == [str(reply.id)]

    def test_automatic_and_agent_messages(self, member, channel, send, search):
        automatic = Message.objects.create(
            channel=channel, system_event=MessageSystemEvent.WORK_ITEM_STATE, body_html="<p>EMP-1 moved to Done</p>"
        )
        agent = Message.objects.create(channel=channel, sender_agent="helper", body_html="<p>Done, moved it</p>")
        person = send(channel, member.user, "moved the desk")
        assert _ids(search(member, "moved")) == [str(person.id), str(agent.id), str(automatic.id)]
        assert _ids(search(member, "moved", automatic="false")) == [str(person.id), str(agent.id)]
        res = search(member, "emp")
        assert res.data["results"][0]["message"]["system_event"] == "work_item_state"
        assert res.data["results"][0]["message"]["sender"] is None


@pytest.mark.contract
@pytest.mark.django_db
class TestAttachmentNames:
    def test_members_find_a_file_by_its_name(self, member, make_channel, send, upload, search):
        channel = make_channel(members=[member.user])
        message = send(channel, member.user, "see attached")
        upload(channel, member.user, "Q3-invoice_final.pdf", on=message)
        for query in ("invoice", "q3 invoice", "final pdf"):
            res = search(member, query)
            assert _ids(res) == [str(message.id)], query
        assert res.data["results"][0]["message"]["attachments"][0]["name"] == "Q3-invoice_final.pdf"

    def test_a_reader_outside_the_channel_doesnt_match_file_names(
        self, member, member2, make_channel, send, upload, search
    ):
        channel = make_channel(members=[member.user])
        message = send(channel, member.user, "see attached invoice")
        upload(channel, member.user, "salaries.xlsx", on=message)
        # member2 can read this public channel, but isn't shown its files, so can't search their names.
        assert _ids(search(member2, "salaries")) == []
        assert _ids(search(member2, "invoice")) == [str(message.id)]
        assert _ids(search(member, "salaries")) == [str(message.id)]

    def test_deleted_and_unsent_files_dont_match(self, member, make_channel, send, upload, search, url):
        channel = make_channel(members=[member.user])
        upload(channel, member.user, "draft-notes.txt")
        upload(channel, member.user, "old-notes.txt", on=send(channel, member.user, "x1"), is_deleted=True)
        removed = send(channel, member.user, "x2")
        upload(channel, member.user, "gone-notes.txt", on=removed)
        member.client.delete(url(f"channels/{channel.id}/messages/{removed.id}/"))
        assert _ids(search(member, "notes")) == []

    def test_another_workspaces_files_dont_match(self, member, other_workspace, make_channel, send, upload, search):
        WorkspaceMember.objects.create(workspace=other_workspace, member=member.user, role=MEMBER)
        there = make_channel(members=[member.user], in_workspace=other_workspace)
        upload(there, member.user, "elsewhere.pdf", on=send(there, member.user, "x"))
        assert _ids(search(member, "elsewhere")) == []


ODD_INPUT = [
    '""',
    "''",
    '"unclosed phrase',
    "&|!:*",
    "foo:*",
    "foo & | bar",
    "!!x",
    "(((",
    ")))",
    "\\\\",
    "back\\slash",
    "--",
    "- -",
    "or",
    "or or",
    "-or",
    "' or 1=1 --",
    "'; DROP TABLE chat_messages; --",
    "<script>alert(1)</script>",
    "%_%",
    "the and of",
    "東京",
    "🚀🚀",
    "é́́́",
    "x" * 200,
    " ".join(["word"] * 60)[:200],
]


@pytest.mark.contract
@pytest.mark.django_db
class TestOddInput:
    @pytest.mark.parametrize("q", ODD_INPUT)
    def test_never_an_error(self, member, make_channel, send, search, q):
        send(make_channel(members=[member.user]), member.user, "some text")
        res = search(member, q)
        assert res.status_code == 200 and isinstance(res.data["results"], list)

    @pytest.mark.parametrize("q", ["", " ", "a", " a ", '"', "-", "x" * 201])
    def test_too_short_or_too_long_is_400(self, member, search, q):
        assert search(member, q).status_code == 400

    def test_no_query_or_a_nul_is_400(self, member, url, search):
        assert member.client.get(url("search/")).status_code == 400
        assert search(member, "ab\x00cd").status_code == 400

    def test_only_punctuation_finds_nothing(self, member, make_channel, send, search):
        send(make_channel(members=[member.user]), member.user, "!!! ??? ...")
        res = search(member, "!?.")
        assert res.status_code == 200 and res.data == {"results": [], "has_more": False}

    def test_random_input_is_always_a_valid_query(self, member, workspace):
        rng = random.Random(17)
        alphabet = "ab é東'\"\\&|!:*()<>-_ or\t\n%"
        for _ in range(300):
            text = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 40)))
            query = to_tsquery_text(text)
            if query:
                list(search_messages(member.user, workspace.slug, MEMBER, query)[:1])

    def test_one_letter_last_word_is_not_a_prefix(self):
        assert to_tsquery_text("deploy x") == "'deploy' & 'x'"
        assert to_tsquery_text("deploy xy") == "'deploy' & 'xy':*"
        assert to_tsquery_text("deploy -xy") == "'deploy' & !'xy'"

    @pytest.mark.parametrize("text", ["-xy", "-deploy -release", "deploy or -xy"])
    def test_only_words_left_out_find_nothing(self, member, make_channel, send, search, text):
        # Nearly every message would match, and the index can't narrow such a query down.
        send(make_channel(members=[member.user]), member.user, "release notes")
        assert to_tsquery_text(text) == ""
        res = search(member, text)
        assert res.status_code == 200 and res.data == {"results": [], "has_more": False}

    def test_words_inside_angle_brackets_are_found(self, member, make_channel, send, search):
        # Pasted code: Postgres's parser would take `<Button variant="primary">` for a tag and drop its words.
        sent = send(make_channel(members=[member.user]), member.user, '&lt;Button variant="primary"&gt;')
        assert sent.body_stripped == '<Button variant="primary">'
        for word in ("button", "variant", "primary"):
            assert _ids(search(member, word)) == [str(sent.id)], word


@pytest.mark.contract
@pytest.mark.django_db
class TestPagesAndFilters:
    @pytest.fixture
    def channel(self, make_channel, member):
        return make_channel(members=[member.user])

    def test_newest_first_in_pages(self, member, channel, send, search):
        messages = [send(channel, member.user, f"standup {i}") for i in range(25)]
        newest_first = [str(message.id) for message in reversed(messages)]
        first = search(member, "standup", limit=10)
        assert _ids(first) == newest_first[:10] and first.data["has_more"] is True
        second = search(member, "standup", limit=10, before=_ids(first)[-1])
        assert _ids(second) == newest_first[10:20] and second.data["has_more"] is True
        third = search(member, "standup", limit=10, before=_ids(second)[-1])
        assert _ids(third) == newest_first[20:] and third.data["has_more"] is False

    def test_a_cursor_that_stopped_matching_still_works(self, member, channel, send, search, url):
        older, cursor = send(channel, member.user, "lunch a"), send(channel, member.user, "lunch b")
        member.client.patch(
            url(f"channels/{channel.id}/messages/{cursor.id}/"), {"body_html": "<p>dinner</p>"}, format="json"
        )
        assert _ids(search(member, "lunch", before=cursor.id)) == [str(older.id)]

    def test_a_cursor_must_be_a_message_the_reader_can_read(self, member, member2, channel, make_channel, send, search):
        hidden = send(make_channel(ChannelKind.PRIVATE, members=[member2.user]), member2.user, "lunch")
        assert search(member, "lunch", before=hidden.id).status_code == 400
        assert search(member, "lunch", before="not-an-id").status_code == 400
        assert search(member, "lunch", limit=51).status_code == 400

    def test_in_a_channel(self, member, member2, channel, make_channel, send, search):
        here = send(channel, member.user, "release notes")
        send(make_channel(members=[member.user]), member.user, "release notes")
        assert _ids(search(member, "release", channel=channel.id)) == [str(here.id)]
        private = make_channel(ChannelKind.PRIVATE, members=[member.user])
        send(private, member.user, "release notes")
        # A channel the reader can't see is a 404, as everywhere else.
        assert search(member2, "release", channel=private.id).status_code == 404
        assert search(member2, "release", channel=uuid4()).status_code == 404

    def test_from_a_person(self, member, member2, make_channel, send, search):
        channel = make_channel(members=[member.user, member2.user])
        mine = send(channel, member.user, "status update")
        send(channel, member2.user, "status update")
        assert _ids(search(member2, "status", sender=member.user.id)) == [str(mine.id)]
        assert search(member2, "status", sender="someone").status_code == 400

    def test_a_date_range(self, member, channel, send, search):
        old, new = send(channel, member.user, "report"), send(channel, member.user, "report")
        Message.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=10))
        cutoff = (timezone.now() - timedelta(days=5)).isoformat()
        assert _ids(search(member, "report", since=cutoff)) == [str(new.id)]
        assert _ids(search(member, "report", until=cutoff)) == [str(old.id)]
        assert search(member, "report", since=cutoff, until=cutoff).status_code == 400
        assert search(member, "report", since="yesterday").status_code == 400


@pytest.mark.contract
@pytest.mark.django_db
class TestResults:
    def test_what_a_result_holds(self, member, member2, workspace, send, search):
        dm, _ = Channel.objects.get_or_create_dm(workspace, member.user, member2.user)
        message = send(dm, member2.user, "can you review the pricing page")
        result = search(member, "pricing").data["results"][0]
        assert result["message"]["id"] == message.id
        assert result["message"]["sender"] == member2.user.id and result["message"]["parent"] is None
        assert result["message"]["created_at"]
        assert result["channel"] == {
            "id": dm.id,
            "kind": "dm",
            "name": "",
            "archived_at": None,
            "is_member": True,
            "dm_member_ids": dm.dm_key.split(":"),
        }
        assert result["snippet"] == [
            {"text": "can you review the ", "match": False},
            {"text": "pricing", "match": True},
            {"text": " page", "match": False},
        ]

    def test_a_snippet_is_plain_text(self, member, make_channel, search):
        channel = make_channel(members=[member.user])
        Message.objects.create(
            channel=channel, sender=member.user, body_html="<p>try &lt;b&gt;bold&lt;/b&gt; \x02here\x03 now</p>"
        )
        snippet = search(member, "bold").data["results"][0]["snippet"]
        # What was typed comes back as text; the only marks are the server's own.
        assert snippet == [
            {"text": "try <b>", "match": False},
            {"text": "bold", "match": True},
            {"text": "</b> here now", "match": False},
        ]

    def test_a_long_message_is_cut_around_the_match(self, member, make_channel, send, search):
        channel = make_channel(members=[member.user])
        words = [f"w{i}" for i in range(100)]
        words[50] = "needle"
        send(channel, member.user, " ".join(words))
        snippet = search(member, "needle").data["results"][0]["snippet"]
        assert snippet[0]["text"].startswith("… ") and snippet[-1]["text"].endswith(" …")
        assert {"text": "needle", "match": True} in snippet
        assert len("".join(segment["text"] for segment in snippet).split()) <= 32

    def test_a_fixed_number_of_queries(self, member, make_channel, send, search):
        channel = make_channel(members=[member.user])

        def count():
            with CaptureQueriesContext(connection) as queries:
                assert search(member, "ticket").status_code == 200
            return len(queries)

        send(channel, member.user, "ticket")
        one = count()
        for i in range(15):
            parent = send(make_channel(members=[member.user]), member.user, f"ticket {i}")
            send(parent.channel, member.user, "ticket reply", parent=parent)
        assert count() == one


@pytest.mark.contract
@pytest.mark.django_db
def test_the_index_is_used(member, workspace, make_channel):
    """With a few thousand messages, matching goes through the GIN index rather than reading every row."""
    channels = [make_channel(members=[member.user]) for _ in range(5)]
    words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]
    rng = random.Random(3)
    rows = []
    for i in range(4000):
        text = " ".join(rng.choice(words) + str(rng.randint(0, 500)) for _ in range(8))
        rows.append(
            Message(
                channel=channels[i % 5],
                workspace=workspace,
                sender=member.user,
                body_html=f"<p>{text}</p>",
                body_stripped=text,
            )
        )
    rows[1234].body_stripped += " zebra"
    Message.objects.bulk_create(rows)
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE chat_messages")

    def page(word):
        """The endpoint's query for the first page."""
        query_text = to_tsquery_text(word)
        matches = search_messages(member.user, workspace.slug, MEMBER, query_text)
        return with_snippet(annotate_messages(matches), query_text).order_by("-created_at", "-id")[:21]

    plan = page("zebra").explain(verbose=True)
    print("\nEXPLAIN VERBOSE for a rare word over 4000 messages:\n" + plan)
    assert (
        "Bitmap Index Scan on public.chat_message_search_idx" in plan
        or "Bitmap Index Scan on chat_message_search_idx" in plan
    )
    assert [message.id for message in page("zebra")] == [rows[1234].id]
    print("\nEXPLAIN for a word in most messages:\n" + page("alpha").explain())


def test_plain_text():
    assert plain_text("") == ""
    assert plain_text("<p>a</p><p>b<br>c</p><ul><li>d</li><li>e</li></ul>") == "a\nb\nc\nd\ne"
    assert plain_text("<p>x <strong>bo</strong>ld &lt;tag&gt; &amp;&nbsp;y</p>") == "x bold <tag> & y"
