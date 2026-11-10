# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Searching messages: Postgres full-text search over the messages a reader may read right now.

What counts as readable is `permissions.visible_channels`, the rule every read endpoint uses: the channels and DMs
the reader is in, and public channels for workspace members and admins. Archived channels can still be read, so they
are searched too. Removed messages never match: their body is cleared when they are removed.

Matching uses the `simple` configuration (see `models.message.search_document`), with Postgres's own
`websearch_to_tsquery`, so whatever is typed gives a valid query: quotes make a phrase, `or` either word, and `-` leaves
a word out. The last word also matches as a prefix, so results come while it is still being typed. An attachment's
filename matches too, but only for channel members: nobody else is shown the files (`attachments.attachments_for`).

Results are newest first, not by rank: ranking would have to score every match before the first page, and chat is
read by when it was said.
"""

import re

from django.contrib.postgres.search import SearchConfig, SearchQueryField, SearchVector
from django.db import connection
from django.db.models import BooleanField, Func, TextField, UUIDField, Value
from django.db.models.expressions import RawSQL
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast

from plane.chat.attachments import assets
from plane.chat.models import ChannelMember, Message, search_document
from plane.chat.permissions import visible_channels

MIN_QUERY_LENGTH = 2
MAX_QUERY_LENGTH = 200
# A shorter last word isn't matched as a prefix: one letter would match most of the table.
MIN_PREFIX_LENGTH = 2

# Around each match in a snippet. Taken out of the text first, so only Postgres's own marks remain.
_START, _STOP = "\x02", "\x03"
# Stands in for "<" while Postgres makes the headline, which would otherwise drop text that looks like a tag.
_LT = "\x04"
_SNIPPET_OPTIONS = f"StartSel={_START}, StopSel={_STOP}, MaxWords=30, MinWords=12"
# The last term of a tsquery's text form, and whether it is negated.
_LAST_TERM = re.compile(r"(!?)'((?:[^']|'')+)'$")


class _Matches(Func):
    """`vector @@ query`."""

    template = "%(expressions)s"
    arg_joiner = " @@ "
    output_field = BooleanField()


def to_tsquery_text(text):
    """What `text` searches for, as the text of a tsquery, or "" when there is nothing in it to search for.

    Postgres parses it (`websearch_to_tsquery` never raises), then the last term becomes a prefix. The result is
    Postgres's own output with `:*` added after a quoted lexeme, which always parses back.
    """
    with connection.cursor() as cursor:
        cursor.execute("SELECT q::text, querytree(q) FROM websearch_to_tsquery('simple', %s) AS q", [text])
        query, indexable = cursor.fetchone()
    if indexable == "T":
        # Only words to leave out (`-word`, or `a or -b`): nearly every message matches, and the index can't narrow
        # it, so the search would read the whole table. Nothing to look for.
        return ""
    last = _LAST_TERM.search(query)
    if last and not last.group(1) and len(last.group(2).replace("''", "'")) >= MIN_PREFIX_LENGTH:
        query += ":*"
    return query


def _tsquery(query_text):
    return RawSQL("%s::tsquery", (query_text,), output_field=SearchQueryField())


def _filename_document():
    """A filename as words: `Q3-invoice_final.pdf` is one token to Postgres, so punctuation becomes spaces first."""
    name = KeyTextTransform("name", "attributes")
    words = Func(
        name, Value("[[:punct:]]+"), Value(" "), Value("g"), function="regexp_replace", output_field=TextField()
    )
    return SearchVector(words, config="simple")


def readable_messages(user, slug, role):
    """Every message in the channels the reader may read, removed ones included (they are still valid cursors)."""
    return Message.objects.filter(channel__in=visible_channels(user, slug, role).values("pk"))


def search_messages(user, slug, role, query_text):
    """The messages `user` may read that match `query_text` (from `to_tsquery_text`), unordered.

    A body match comes from the GIN index. A filename match is limited to the channels the reader is in.
    """
    tsquery = _tsquery(query_text)
    in_body = Message.objects.filter(workspace__slug=slug).filter(_Matches(search_document(), tsquery))
    named = (
        assets()
        .filter(workspace__slug=slug, entity_identifier__isnull=False)
        .filter(_Matches(_filename_document(), tsquery))
        # Always a message ID on this entity type (`attachments.claim_attachments`).
        .values(message_id=Cast("entity_identifier", UUIDField()))
    )
    in_filenames = Message.objects.filter(
        pk__in=named, channel__in=ChannelMember.objects.filter(user=user).values("channel_id")
    )
    # An ID listed twice does no harm to `IN`, so skip the work of removing duplicates.
    matching = in_body.order_by().values("pk").union(in_filenames.order_by().values("pk"), all=True)
    # An agent's reply still being written is matched once it is finished.
    return readable_messages(user, slug, role).filter(removed_at__isnull=True, agent_streaming=False, pk__in=matching)


def with_snippet(queryset, query_text):
    """Add `snippet`: Postgres's headline of the body, with each match between `_START` and `_STOP`."""
    body = Func(
        "body_stripped", Value("<" + _START + _STOP + _LT), Value(_LT), function="translate", output_field=TextField()
    )
    headline = Func(
        SearchConfig("simple"),
        body,
        _tsquery(query_text),
        Value(_SNIPPET_OPTIONS),
        function="ts_headline",
        output_field=TextField(),
    )
    return queryset.annotate(snippet=headline)


def snippet_segments(headline, body):
    """The headline as `[{"text", "match"}]`, plain text only: the client renders it as text, never as HTML.

    An ellipsis marks text left out at either end.
    """
    segments = []

    def add(text, match, at_start=False):
        if not text:
            return
        edge = 0 if at_start else -1
        if segments and segments[edge]["match"] == match:
            segments[edge]["text"] = text + segments[edge]["text"] if at_start else segments[edge]["text"] + text
        else:
            segments.insert(0 if at_start else len(segments), {"text": text, "match": match})

    for index, part in enumerate((headline or "").replace(_LT, "<").split(_START)):
        matched, _, rest = part.partition(_STOP) if index else ("", "", part)
        add(matched, True)
        add(rest, False)
    shown = "".join(segment["text"] for segment in segments)
    body = "".join(char for char in body or "" if char not in (_START, _STOP, _LT))
    at = body.find(shown) if shown else -1
    if at > 0:
        add("… ", False, at_start=True)
    if at >= 0 and at + len(shown) < len(body):
        add(" …", False)
    return segments
