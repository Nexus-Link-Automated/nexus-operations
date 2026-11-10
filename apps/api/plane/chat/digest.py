# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""An email digest of the @mentions someone has left unread.

Each @mention that makes an inbox entry (`plane.chat.notifications`) is also queued as a `PendingMentionEmail`.
Every five minutes `send_mention_digests` takes the queued mentions that are `CHAT_MENTION_EMAIL_DELAY_MINUTES` old
and sends each person one email listing the ones still worth telling them about. A run deletes every mention it takes
from the queue, emailed or not, and locks them while it decides, skipping any another run has locked: so a mention
is emailed at most once however many runs overlap, and a retried send resends the same email, never a new one.

A mention is emailed only if, when it is taken:

- its inbox entry is unread, not archived and not snoozed;
- its receiver's read cursor in the channel hasn't reached it, so they haven't had the channel open since it was
  sent. The cursor is a top-level message, so a reply counts as seen once a top-level message posted after it is;
- the receiver can still open it, as the inbox checks (`visible_chat_mentions`): still an active member of the
  workspace, still able to see the channel, and the message neither removed nor its channel deleted;
- the channel isn't set to "Nothing" for them, and their "Mentions" email preference (`UserNotificationPreference`,
  the same switch as for work items) is on.

With no SMTP host or no app URL configured, mentions that come due are dropped rather than kept, so setting email up
later doesn't send a backlog of old mentions.

The email is English, like the rest of Plane's emails.
"""

from datetime import timedelta
from functools import reduce
from operator import or_

from celery import shared_task
from celery.exceptions import Retry
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.mail import EmailMultiAlternatives, get_connection
from django.db import transaction
from django.db.models import BooleanField, Exists, ExpressionWrapper, OuterRef, Q, Value
from django.template.loader import render_to_string
from django.utils import timezone

from plane.bgtasks.email_notification_task import remove_unwanted_characters
from plane.chat.models import ChannelMember, ChannelNotificationLevel, PendingMentionEmail
from plane.chat.notifications import message_url, visible_chat_mentions
from plane.db.models import Notification, UserNotificationPreference, WorkspaceMember
from plane.license.utils.instance_value import get_email_configuration
from plane.utils.email import EMAIL_TASK_MAX_RETRIES, send_email_with_retry
from plane.utils.exception_logger import log_exception
from plane.utils.host import base_host

PREVIEW_LENGTH = 200
# The most mentions one email lists; any more are counted, and the inbox has them all.
MAX_MENTIONS_PER_EMAIL = 20
# The most people one run emails; the rest wait in the queue for the next run.
MAX_RECEIVERS_PER_RUN = 200


def _preview(text):
    text = " ".join(text.split())
    return text if len(text) <= PREVIEW_LENGTH else text[: PREVIEW_LENGTH - 1].rstrip() + "…"


def _worth_emailing(receiver_id, roles, now):
    """Whether a queued mention of `receiver_id` is to be emailed. `roles` maps their active workspaces to roles."""
    if not roles:
        return Value(False, output_field=BooleanField())
    can_see = reduce(or_, (Q(workspace_id=ws) & visible_chat_mentions(receiver_id, role) for ws, role in roles.items()))
    unread_entry = Notification.objects.filter(
        can_see, pk=OuterRef("notification_id"), read_at__isnull=True, archived_at__isnull=True
    ).exclude(snoozed_till__gt=now)
    membership = ChannelMember.objects.filter(channel_id=OuterRef("message__channel_id"), user_id=receiver_id)
    seen_in_channel = membership.filter(
        Q(last_read_message__created_at__gt=OuterRef("message__created_at"))
        | Q(
            last_read_message__created_at=OuterRef("message__created_at"),
            last_read_message_id__gte=OuterRef("message_id"),
        )
    )
    muted = membership.filter(notification_level=ChannelNotificationLevel.NONE)
    opted_out = UserNotificationPreference.objects.filter(user_id=receiver_id, mention=False)
    return ExpressionWrapper(
        Q(Exists(unread_entry)) & ~Q(Exists(seen_in_channel)) & ~Q(Exists(muted)) & ~Q(Exists(opted_out)),
        output_field=BooleanField(),
    )


def _take(receiver_id, due_before):
    """Remove the receiver's due mentions from the queue, and return the ones to email, oldest first."""
    # Bot accounts (a workspace's seed bot is an admin member) have addresses that nobody reads.
    roles = dict(
        WorkspaceMember.objects.filter(
            member_id=receiver_id, is_active=True, member__is_active=True, member__is_bot=False
        ).values_list("workspace_id", "role")
    )
    with transaction.atomic():
        taken = list(
            PendingMentionEmail.objects.select_for_update(skip_locked=True, of=("self",))
            .filter(receiver_id=receiver_id, created_at__lte=due_before)
            .annotate(worth_emailing=_worth_emailing(receiver_id, roles, timezone.now()))
            .select_related("receiver", "message__channel__workspace", "message__sender")
            # In the order the mentions were made: queued at the same moment (one bulk insert), the rows tie.
            .order_by("message__created_at", "message_id")
        )
        if taken:
            PendingMentionEmail.objects.filter(pk__in=[pending.pk for pending in taken]).delete()
    return [pending for pending in taken if pending.worth_emailing]


def _mention(pending, base_url):
    message = pending.message
    channel = message.channel
    return {
        "sender": (message.sender.display_name if message.sender else message.sender_agent) or "Someone",
        "place": "a direct message" if channel.is_direct else f"#{channel.name}",
        "workspace": channel.workspace.name,
        "preview": _preview(message.body_stripped),
        "url": message_url(base_url, channel.workspace.slug, message),
    }


def _email(mentions, receiver, base_url):
    """The subject, plain text and HTML of the digest of `mentions`."""
    if len(mentions) == 1:
        subject = f"{mentions[0]['sender']} mentioned you in {mentions[0]['place']}"
    else:
        subject = f"You have {len(mentions)} unread mentions"
    context = {
        "total": len(mentions),
        "mentions": mentions[:MAX_MENTIONS_PER_EMAIL],
        "more": max(len(mentions) - MAX_MENTIONS_PER_EMAIL, 0),
        "receiver_email": receiver.email,
        "settings_url": f"{base_url}/settings/profile/notifications",
    }
    return (
        remove_unwanted_characters(subject),
        render_to_string("emails/notifications/chat-mention-digest.txt", context),
        render_to_string("emails/notifications/chat-mention-digest.html", context),
    )


@shared_task(bind=True, max_retries=EMAIL_TASK_MAX_RETRIES)
def send_mention_digest_email(self, to, subject, text, html):
    """Send one digest, retrying a failed delivery of the same email."""
    try:
        (
            EMAIL_HOST,
            EMAIL_HOST_USER,
            EMAIL_HOST_PASSWORD,
            EMAIL_PORT,
            EMAIL_USE_TLS,
            EMAIL_USE_SSL,
            EMAIL_FROM,
        ) = get_email_configuration()
        connection = get_connection(
            host=EMAIL_HOST,
            port=int(EMAIL_PORT),
            username=EMAIL_HOST_USER,
            password=EMAIL_HOST_PASSWORD,
            use_tls=EMAIL_USE_TLS == "1",
            use_ssl=EMAIL_USE_SSL == "1",
        )
        msg = EmailMultiAlternatives(subject=subject, body=text, from_email=EMAIL_FROM, to=[to], connection=connection)
        msg.attach_alternative(html, "text/html")
        send_email_with_retry(self, msg, EMAIL_HOST)
    except Retry:
        raise
    except Exception as error:
        log_exception(error)


def _app_url():
    try:
        return base_host(request=None, is_app=True).rstrip("/")
    except ImproperlyConfigured:
        return None


@shared_task
def send_mention_digests():
    """Email everyone a digest of their mentions still unread `CHAT_MENTION_EMAIL_DELAY_MINUTES` after they came."""
    due_before = timezone.now() - timedelta(minutes=settings.CHAT_MENTION_EMAIL_DELAY_MINUTES)
    due = PendingMentionEmail.objects.filter(created_at__lte=due_before)
    base_url = _app_url()
    if not get_email_configuration()[0] or not base_url:
        due.delete()
        return
    receivers = due.order_by().values_list("receiver_id", flat=True).distinct()[:MAX_RECEIVERS_PER_RUN]
    for receiver_id in list(receivers):
        try:
            taken = _take(receiver_id, due_before)
            if not taken:
                continue
            receiver = taken[0].receiver
            subject, text, html = _email([_mention(pending, base_url) for pending in taken], receiver, base_url)
            send_mention_digest_email.delay(receiver.email, subject, text, html)
        except Exception as error:
            log_exception(error)
