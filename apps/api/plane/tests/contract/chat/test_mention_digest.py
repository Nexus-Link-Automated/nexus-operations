# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Mentions still unread after a while are emailed, once, in one digest per person."""

import smtplib
import threading
from contextlib import ExitStack
from datetime import timedelta
from unittest import mock

import pytest
from django.conf import settings
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from plane.chat import digest
from plane.chat.models import (
    Channel,
    ChannelKind,
    ChannelMember,
    ChannelNotificationLevel,
    Message,
    PendingMentionEmail,
)
from plane.chat.notifications import notify_mentions
from plane.db.models import Notification, User, UserNotificationPreference, WorkspaceMember

APP_URL = "https://app.example.com"
SMTP_CONFIG = ("smtp.example.com", "smtp-user", "smtp-password", "587", "1", "0", "Plane <noreply@example.com>")
NO_SMTP = ("", "", "", "587", "1", "0", "Plane <noreply@example.com>")


def mention(user):
    return f'<mention-component entity_name="user_mention" entity_identifier="{user.id}"></mention-component>'


@pytest.fixture(autouse=True)
def app_url():
    with override_settings(WEB_URL=APP_URL, APP_BASE_URL=None):
        yield


@pytest.fixture
def say():
    """`sender` posts `text` mentioning `mentioned` in `channel`, which makes inbox entries as the API would."""

    def say(channel, sender, *mentioned, text="please review", parent=None):
        message = Message.objects.create(
            channel=channel,
            sender=sender,
            parent=parent,
            body_html=f"<p>{text} {''.join(mention(user) for user in mentioned)}</p>",
        )
        notify_mentions(message)
        return message

    return say


def come_due(**queued):
    """Make the queued mentions as old as the delay, so the next run takes them."""
    old = timezone.now() - timedelta(minutes=settings.CHAT_MENTION_EMAIL_DELAY_MINUTES, seconds=1)
    PendingMentionEmail.objects.filter(**queued).update(created_at=old)


def run(smtp_config=SMTP_CONFIG, smtp=None):
    """One beat run, with each digest delivered at once (following its retries) instead of through the broker."""
    task = digest.send_mention_digest_email
    with ExitStack() as stack:
        stack.enter_context(mock.patch.object(digest, "get_email_configuration", return_value=smtp_config))
        stack.enter_context(mock.patch.object(task, "delay", side_effect=lambda *args: task.apply(args=args)))
        if smtp is not None:
            stack.enter_context(mock.patch.object(digest, "get_connection", return_value=smtp))
        digest.send_mention_digests()


def entry(user, message):
    return Notification.objects.get(receiver=user, entity_identifier=message.id)


def html_of(email):
    [(html, mimetype)] = email.alternatives
    assert mimetype == "text/html"
    return html


@pytest.fixture
def channel(make_channel, member, member2):
    return make_channel(name="design", members=[member.user, member2.user])


@pytest.fixture
def ada(member):
    User.objects.filter(pk=member.user.pk).update(display_name="ada")
    member.user.refresh_from_db()
    return member.user


@pytest.mark.contract
class TestWhoIsEmailed:
    def test_a_mention_left_unread_is_emailed_once(self, channel, ada, member2, say, mailoutbox):
        message = say(channel, ada, member2.user)
        come_due()

        run()
        run()

        [email] = mailoutbox
        assert email.to == [member2.user.email]
        assert email.subject == "ada mentioned you in #design"
        assert f"{APP_URL}/test-workspace/messages/{channel.id}?message={message.id}" in email.body
        assert not PendingMentionEmail.objects.exists()

    def test_nothing_is_sent_before_the_delay(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)

        run()

        assert mailoutbox == []
        assert PendingMentionEmail.objects.count() == 1

    def test_someone_who_read_the_channel_since_is_not_emailed(self, channel, ada, member2, say, mailoutbox):
        message = say(channel, ada, member2.user)
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(last_read_message=message)
        come_due()

        run()

        assert mailoutbox == []
        assert not PendingMentionEmail.objects.exists()

    def test_a_read_cursor_before_the_mention_does_not_count(self, channel, ada, member2, say, send, mailoutbox):
        earlier = send(channel, member2.user)
        say(channel, ada, member2.user)
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(last_read_message=earlier)
        come_due()

        run()

        assert len(mailoutbox) == 1

    def test_a_reply_counts_as_seen_once_the_cursor_passes_it(self, channel, ada, member2, say, send, mailoutbox):
        thread = send(channel, ada)
        say(channel, ada, member2.user, parent=thread)
        # The cursor on the thread itself is before the reply.
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(last_read_message=thread)
        come_due()
        run()
        assert len(mailoutbox) == 1

        say(channel, ada, member2.user, parent=thread)
        later = send(channel, ada)
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(last_read_message=later)
        come_due()
        run()
        assert len(mailoutbox) == 1

    @pytest.mark.parametrize(
        "handled",
        [
            {"read_at": timezone.now()},
            {"archived_at": timezone.now()},
            {"snoozed_till": timezone.now() + timedelta(days=1)},
        ],
        ids=["read", "archived", "snoozed"],
    )
    def test_an_entry_handled_in_the_inbox_is_not_emailed(self, channel, ada, member2, say, mailoutbox, handled):
        message = say(channel, ada, member2.user)
        Notification.objects.filter(pk=entry(member2.user, message).pk).update(**handled)
        come_due()

        run()

        assert mailoutbox == []

    def test_a_snooze_that_ended_does_not_stop_the_email(self, channel, ada, member2, say, mailoutbox):
        message = say(channel, ada, member2.user)
        Notification.objects.filter(pk=entry(member2.user, message).pk).update(snoozed_till=timezone.now())
        come_due()

        run()

        assert len(mailoutbox) == 1

    def test_a_removed_message_is_not_emailed(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user).remove()
        come_due()

        run()

        assert mailoutbox == []
        assert not PendingMentionEmail.objects.exists()

    def test_someone_who_left_a_private_channel_is_not_emailed(self, make_channel, ada, member2, say, mailoutbox):
        private = make_channel(kind=ChannelKind.PRIVATE, members=[ada, member2.user])
        say(private, ada, member2.user)
        ChannelMember.objects.get(channel=private, user=member2.user).delete()
        come_due()

        run()

        assert mailoutbox == []

    def test_someone_still_in_the_private_channel_is_emailed(self, make_channel, ada, member2, say, mailoutbox):
        private = make_channel(kind=ChannelKind.PRIVATE, name="secret", members=[ada, member2.user])
        say(private, ada, member2.user)
        come_due()

        run()

        [email] = mailoutbox
        assert email.subject == "ada mentioned you in #secret"

    def test_a_deleted_channel_is_not_emailed(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)
        Channel.objects.filter(pk=channel.pk).update(deleted_at=timezone.now())
        come_due()

        run()

        assert mailoutbox == []

    def test_someone_who_left_the_workspace_is_not_emailed(self, workspace, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)
        WorkspaceMember.objects.filter(workspace=workspace, member=member2.user).update(is_active=False)
        come_due()

        run()

        assert mailoutbox == []

    def test_a_deactivated_account_is_not_emailed(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)
        User.objects.filter(pk=member2.user.pk).update(is_active=False)
        come_due()

        run()

        assert mailoutbox == []

    def test_a_channel_set_to_nothing_since_is_not_emailed(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(
            notification_level=ChannelNotificationLevel.NONE
        )
        come_due()

        run()

        assert mailoutbox == []

    def test_a_channel_set_to_nothing_queues_nothing(self, channel, ada, member2, say):
        ChannelMember.objects.filter(channel=channel, user=member2.user).update(
            notification_level=ChannelNotificationLevel.NONE
        )
        say(channel, ada, member2.user)
        assert not PendingMentionEmail.objects.exists()

    def test_the_mentions_email_preference_turns_it_off(self, channel, ada, member2, say, mailoutbox):
        UserNotificationPreference.objects.filter(user=member2.user).update(mention=False)
        say(channel, ada, member2.user)
        come_due()

        run()

        assert mailoutbox == []

    def test_a_workspace_member_outside_a_public_channel_is_emailed(self, make_channel, ada, member2, say, mailoutbox):
        public = make_channel(name="general", members=[ada])
        say(public, ada, member2.user)
        come_due()

        run()

        assert [email.to for email in mailoutbox] == [[member2.user.email]]


@pytest.mark.contract
class TestTheDigest:
    def test_one_email_per_person_lists_all_their_mentions(
        self, workspace, make_channel, channel, ada, member2, make_actor, say, mailoutbox
    ):
        third = make_actor().user
        other = make_channel(name="ops", members=[ada, member2.user, third])
        dm, _ = Channel.objects.get_or_create_dm(workspace, ada, member2.user)
        say(channel, ada, member2.user, text="first")
        say(other, ada, member2.user, third, text="second")
        say(dm, ada, member2.user, text="third")
        come_due()

        run()

        by_receiver = {email.to[0]: email for email in mailoutbox}
        assert set(by_receiver) == {member2.user.email, third.email}
        digest_email = by_receiver[member2.user.email]
        assert digest_email.subject == "You have 3 unread mentions"
        for text in ("#design", "#ops", "a direct message", "first", "second", "third"):
            assert text in digest_email.body
            assert text in html_of(digest_email)
        assert by_receiver[third.email].subject == "ada mentioned you in #ops"

    def test_a_direct_message_is_not_named(self, workspace, ada, member2, say, mailoutbox):
        dm, _ = Channel.objects.get_or_create_dm(workspace, ada, member2.user)
        say(dm, ada, member2.user)
        come_due()

        run()

        [email] = mailoutbox
        assert email.subject == "ada mentioned you in a direct message"

    def test_a_reply_links_to_its_thread_with_the_reply_highlighted(self, channel, ada, member2, say, send, mailoutbox):
        thread = send(channel, ada)
        reply = say(channel, ada, member2.user, parent=thread)
        come_due()

        run()

        [email] = mailoutbox
        link = f"{APP_URL}/test-workspace/messages/{channel.id}?message={thread.id}&amp;reply={reply.id}"
        assert link in html_of(email)
        assert link.replace("&amp;", "&") in email.body

    def test_it_links_to_the_notification_settings(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)
        come_due()

        run()

        [email] = mailoutbox
        assert f"{APP_URL}/settings/profile/notifications" in email.body
        assert f'href="{APP_URL}/settings/profile/notifications"' in html_of(email)

    def test_a_long_message_is_shortened(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user, text="word " * 100)
        come_due()

        run()

        [email] = mailoutbox
        assert "word " * 39 + "word…" in email.body
        assert "word " * 41 not in email.body

    def test_a_long_digest_counts_what_it_leaves_out(self, channel, ada, member2, say, mailoutbox):
        for n in range(digest.MAX_MENTIONS_PER_EMAIL + 2):
            say(channel, ada, member2.user, text=f"note {n}")
        come_due()

        run()

        [email] = mailoutbox
        assert email.subject == f"You have {digest.MAX_MENTIONS_PER_EMAIL + 2} unread mentions"
        assert "And 2 more." in email.body
        assert f"note {digest.MAX_MENTIONS_PER_EMAIL - 1}" in email.body
        assert f"note {digest.MAX_MENTIONS_PER_EMAIL}" not in email.body

    def test_names_and_text_are_escaped_in_the_html(self, workspace, make_channel, ada, member2, say, mailoutbox):
        User.objects.filter(pk=ada.pk).update(display_name="<b>ada</b>")
        ada.refresh_from_db()
        workspace.name = "<i>Acme</i>"
        workspace.save()
        tricky = make_channel(name='<img src=x onerror="alert(1)">', members=[ada, member2.user])
        say(tricky, ada, member2.user, text="&lt;script&gt;alert(2)&lt;/script&gt;")
        come_due()

        run()

        [email] = mailoutbox
        html = html_of(email)
        for markup in ("<b>ada</b>", "<i>Acme</i>", "<img src=x", "<script>"):
            assert markup not in html
            assert markup in email.body
        assert "&lt;b&gt;ada&lt;/b&gt;" in html
        assert "&lt;i&gt;Acme&lt;/i&gt;" in html
        assert "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;" in html
        assert "&lt;script&gt;alert(2)&lt;/script&gt;" in html

    def test_the_subject_has_no_line_breaks(self, make_channel, ada, member2, say, mailoutbox):
        User.objects.filter(pk=ada.pk).update(display_name="ada\nBcc: x@example.com")
        ada.refresh_from_db()
        say(make_channel(members=[ada, member2.user]), ada, member2.user)
        come_due()

        run()

        [email] = mailoutbox
        assert "\n" not in email.subject


@pytest.mark.contract
class TestDelivery:
    def test_without_email_configured_nothing_is_sent_and_nothing_piles_up(
        self, channel, ada, member2, say, mailoutbox
    ):
        say(channel, ada, member2.user)
        come_due()

        run(smtp_config=NO_SMTP)
        assert mailoutbox == []
        assert not PendingMentionEmail.objects.exists()

        # Configuring email later doesn't send what came due meanwhile.
        run()
        assert mailoutbox == []

    def test_without_an_app_url_nothing_is_sent(self, channel, ada, member2, say, mailoutbox):
        say(channel, ada, member2.user)
        come_due()

        with override_settings(WEB_URL=None, APP_BASE_URL=None):
            run()

        assert mailoutbox == []

    def test_a_failed_send_is_retried_and_sent_once(self, channel, ada, member2, say):
        say(channel, ada, member2.user)
        come_due()
        smtp = mock.MagicMock()
        smtp.send_messages.side_effect = [smtplib.SMTPServerDisconnected("closed"), 1]

        run(smtp=smtp)
        run(smtp=smtp)

        assert smtp.send_messages.call_count == 2
        [first], [second] = (call.args[0] for call in smtp.send_messages.call_args_list)
        assert first.subject == second.subject == "ada mentioned you in #design"

    def test_a_permanent_failure_is_logged_and_not_retried(self, channel, ada, member2, say):
        say(channel, ada, member2.user)
        come_due()
        smtp = mock.MagicMock()
        smtp.send_messages.side_effect = smtplib.SMTPRecipientsRefused({member2.user.email: (550, b"no such user")})

        with mock.patch.object(digest, "log_exception") as log_exception:
            run(smtp=smtp)
            run(smtp=smtp)

        assert smtp.send_messages.call_count == 1
        log_exception.assert_called_once()

    def test_one_failing_person_does_not_stop_the_others(self, channel, ada, member2, make_actor, say, mailoutbox):
        third = make_actor().user
        ChannelMember.objects.create(channel=channel, user=third)
        say(channel, ada, member2.user, third)
        come_due()
        real = digest._email

        def fail_for_member2(mentions, receiver, base_url):
            if receiver.pk == member2.user.pk:
                raise RuntimeError("boom")
            return real(mentions, receiver, base_url)

        with (
            mock.patch.object(digest, "_email", side_effect=fail_for_member2),
            mock.patch.object(digest, "log_exception"),
        ):
            run()

        assert [email.to for email in mailoutbox] == [[third.email]]

    def test_the_queries_do_not_grow_with_the_mentions(self, channel, ada, make_actor, say):
        def queries_for_one_person(mention_count):
            receiver = make_actor().user
            ChannelMember.objects.create(channel=channel, user=receiver)
            for _ in range(mention_count):
                say(channel, ada, receiver)
            come_due()
            with CaptureQueriesContext(connection) as queries:
                run()
            return len(queries)

        assert queries_for_one_person(1) == queries_for_one_person(6)

    def test_the_run_is_scheduled(self):
        from plane.celery import app

        tasks = {entry["task"] for entry in app.conf.beat_schedule.values()}
        assert "plane.chat.digest.send_mention_digests" in tasks
        assert "plane.chat.digest" in settings.CELERY_IMPORTS


@pytest.mark.contract
@pytest.mark.django_db(transaction=True)
def test_two_runs_at_once_email_a_mention_once(make_channel, make_actor, say, mailoutbox):
    sender, receiver = make_actor().user, make_actor().user
    say(make_channel(members=[sender, receiver]), sender, receiver)
    come_due()
    taken, go = threading.Event(), threading.Event()

    def pause_before_removing(execute, sql, params, many, context):
        if sql.startswith(f'DELETE FROM "{PendingMentionEmail._meta.db_table}"'):
            taken.set()
            go.wait(timeout=10)
        return execute(sql, params, many, context)

    def first_run():
        try:
            with connection.execute_wrapper(pause_before_removing):
                run()
        finally:
            connection.close()

    first = threading.Thread(target=first_run)
    first.start()
    try:
        assert taken.wait(timeout=10)
        run()  # Starts while the first run holds the mention and hasn't yet removed it from the queue.
    finally:
        go.set()
        first.join(timeout=10)

    assert [email.to for email in mailoutbox] == [[receiver.email]]
