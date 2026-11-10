import re
from html import unescape

from django.db import migrations
from django.utils.html import strip_tags

# A copy of `plane.chat.models.message.plain_text` as it was when this ran.
_LINE_END = re.compile(r"<br\b[^>]*>|</(?:p|div|li|h[1-6]|blockquote|pre|tr)\s*>", re.IGNORECASE)


def _plain_text(html):
    if not html:
        return ""
    text = unescape(strip_tags(_LINE_END.sub(lambda end: end.group(0) + "\n", html)))
    return text.replace("\xa0", " ").strip()


def recompute_body_stripped(apps, schema_editor):
    """Give existing messages the new `body_stripped`: entities decoded, and paragraphs no longer run together.

    Each row is written only if its body hasn't changed since it was read, so an edit made meanwhile is kept.
    """
    Message = apps.get_model("chat", "Message")
    rows = Message.objects.exclude(body_html="").values_list("pk", "body_html", "body_stripped")
    for pk, body_html, body_stripped in rows.iterator(chunk_size=1000):
        plain = _plain_text(body_html)
        if plain != body_stripped:
            Message.objects.filter(pk=pk, body_html=body_html).update(body_stripped=plain)


class Migration(migrations.Migration):
    # Each row commits on its own, so a long run doesn't hold every row it has written until it ends.
    atomic = False

    dependencies = [
        ("chat", "0004_message_system_event_channel_project_named_only"),
    ]

    operations = [
        migrations.RunPython(recompute_body_stripped, migrations.RunPython.noop, elidable=True),
    ]
