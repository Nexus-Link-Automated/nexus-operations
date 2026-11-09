# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import errno
import logging
import smtplib
import socket
import ssl
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.test import override_settings

from plane.authentication.provider.credentials.magic_code import MagicCodeProvider
from plane.bgtasks.forgot_password_task import forgot_password
from plane.bgtasks.magic_link_code_task import magic_link
from plane.bgtasks.notification_task import notifications
from plane.bgtasks.project_invitation_task import project_invitation
from plane.bgtasks.user_email_update_task import send_email_update_magic_code
from plane.bgtasks.workspace_invitation_task import workspace_invitation
from plane.db.models import Project, ProjectMemberInvite, WorkspaceMemberInvite

SMTP_CONFIG = ("smtp.example.com", "smtp-user", "smtp-password", "587", "1", "0", "Plane <noreply@example.com>")
SMTP_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
RECIPIENT = "user@example.com"

# The schedule is spelled out here so a change to it has to be made on purpose.
MAX_RETRIES = 4
BACKOFF_SCHEDULE = [10, 20, 40, 80]


def disconnected():
    return smtplib.SMTPServerDisconnected("Connection unexpectedly closed")


@dataclass
class EmailTask:
    module: str
    task: Any
    args: tuple


@dataclass
class TaskRun:
    connection: MagicMock
    log_exception: MagicMock
    retry: MagicMock
    result: Any

    @property
    def sends(self):
        return self.connection.send_messages.call_count


MAGIC_LINK = EmailTask("magic_link_code_task", magic_link, (RECIPIENT, f"magic_{RECIPIENT}", "123456"))


def run_task(email_task, send_results, smtp_config=SMTP_CONFIG):
    """Run the task eagerly, following any retries, with `send_results` as the outcome of each send."""
    connection = MagicMock()
    connection.send_messages.side_effect = send_results
    module = f"plane.bgtasks.{email_task.module}"
    with (
        patch(f"{module}.get_email_configuration", return_value=smtp_config),
        patch(f"{module}.get_connection", return_value=connection),
        patch(f"{module}.log_exception") as log_exception,
        patch.object(email_task.task, "retry", wraps=email_task.task.retry) as retry,
    ):
        result = email_task.task.apply(args=email_task.args)
    return TaskRun(connection=connection, log_exception=log_exception, retry=retry, result=result)


def assert_transient_failure_is_retried(email_task):
    """A task that never retries would pass every "does not retry" test, so prove this one does."""
    run = run_task(email_task, [disconnected(), 1])
    assert run.sends == 2


def subjects_sent(run):
    return [call.args[0][0].subject for call in run.connection.send_messages.call_args_list]


@pytest.fixture(
    params=[
        "magic_link",
        "forgot_password",
        "email_update_magic_code",
        "workspace_invitation",
        "project_invitation",
    ]
)
def email_task(request):
    if request.param == "magic_link":
        return MAGIC_LINK
    if request.param == "forgot_password":
        return EmailTask(
            "forgot_password_task",
            forgot_password,
            ("Test", RECIPIENT, "dWlk", "reset-token", "https://app.example.com"),
        )
    if request.param == "email_update_magic_code":
        return EmailTask("user_email_update_task", send_email_update_magic_code, (RECIPIENT, "123456"))

    workspace = request.getfixturevalue("workspace")
    site = "https://app.example.com"
    if request.param == "workspace_invitation":
        invite = WorkspaceMemberInvite.objects.create(workspace=workspace, email=RECIPIENT, token="invite-token")
        return EmailTask(
            "workspace_invitation_task",
            workspace_invitation,
            (invite.email, str(workspace.id), invite.token, site, workspace.owner.email),
        )

    project = Project.objects.create(name="Invites", identifier="INV", workspace=workspace, created_by=workspace.owner)
    invite = ProjectMemberInvite.objects.create(
        project=project, workspace=workspace, email=RECIPIENT, token="invite-token"
    )
    return EmailTask(
        "project_invitation_task",
        project_invitation,
        (invite.email, str(project.id), invite.token, site, workspace.owner.email),
    )


@pytest.mark.unit
@pytest.mark.django_db
class TestEmailTaskRetries:
    def test_transient_failure_retries_until_sent(self, email_task):
        run = run_task(email_task, [disconnected(), disconnected(), 1])

        assert run.sends == 3
        assert run.retry.call_count == 2
        run.log_exception.assert_not_called()
        assert run.result.successful()

    def test_transient_failure_stops_after_bounded_retries(self, email_task):
        # More failures than the task may ever consume: a bounded task leaves the rest unused.
        run = run_task(email_task, [disconnected() for _ in range(MAX_RETRIES + 5)])

        assert run.sends == MAX_RETRIES + 1
        assert run.retry.call_count == MAX_RETRIES
        run.log_exception.assert_called_once()
        assert run.result.successful()

    def test_permanent_failure_is_logged_and_not_retried(self, email_task):
        assert_transient_failure_is_retried(email_task)

        refused = smtplib.SMTPRecipientsRefused({RECIPIENT: (550, b"no such user")})
        run = run_task(email_task, [refused, 1])

        assert run.sends == 1
        run.retry.assert_not_called()
        run.log_exception.assert_called_once_with(refused)

    def test_successful_send_is_not_retried(self, email_task):
        assert_transient_failure_is_retried(email_task)

        run = run_task(email_task, [1, 1])

        assert run.sends == 1
        run.retry.assert_not_called()
        run.log_exception.assert_not_called()


@pytest.mark.unit
class TestEmailFailureClassification:
    @pytest.mark.parametrize(
        "error",
        [
            pytest.param(disconnected(), id="server-disconnected"),
            pytest.param(smtplib.SMTPConnectError(421, b"too many connections"), id="connect-421"),
            pytest.param(smtplib.SMTPRecipientsRefused({RECIPIENT: (451, b"greylisted")}), id="recipient-451"),
            pytest.param(smtplib.SMTPSenderRefused(451, b"try later", "noreply@example.com"), id="sender-451"),
            pytest.param(smtplib.SMTPDataError(452, b"insufficient storage"), id="data-452"),
            pytest.param(ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"), id="connection-refused"),
            pytest.param(ConnectionResetError(errno.ECONNRESET, "Connection reset"), id="connection-reset"),
            pytest.param(TimeoutError("timed out"), id="timeout"),
            pytest.param(OSError(errno.ENETUNREACH, "Network is unreachable"), id="network-unreachable"),
            pytest.param(socket.gaierror(socket.EAI_AGAIN, "Temporary failure in name resolution"), id="dns-try-again"),
        ],
    )
    def test_transient_errors_are_retried(self, error):
        run = run_task(MAGIC_LINK, [error, 1])

        assert run.sends == 2
        run.log_exception.assert_not_called()

    @pytest.mark.parametrize(
        "error",
        [
            pytest.param(smtplib.SMTPRecipientsRefused({RECIPIENT: (550, b"no such user")}), id="recipient-550"),
            pytest.param(smtplib.SMTPSenderRefused(553, b"sender rejected", "noreply@example.com"), id="sender-553"),
            pytest.param(smtplib.SMTPAuthenticationError(535, b"bad credentials"), id="auth-535"),
            pytest.param(smtplib.SMTPDataError(554, b"message rejected"), id="data-554"),
            pytest.param(smtplib.SMTPNotSupportedError("STARTTLS not supported"), id="starttls-unsupported"),
            pytest.param(ssl.SSLCertVerificationError("certificate verify failed"), id="bad-certificate"),
            pytest.param(socket.gaierror(socket.EAI_NONAME, "Name or service not known"), id="unknown-host"),
            pytest.param(ValueError("Header values can't contain newlines"), id="invalid-message"),
        ],
    )
    def test_permanent_errors_are_not_retried(self, error):
        assert_transient_failure_is_retried(MAGIC_LINK)

        run = run_task(MAGIC_LINK, [error, 1])

        assert run.sends == 1
        run.retry.assert_not_called()
        run.log_exception.assert_called_once_with(error)

    def test_backoff_doubles_and_is_capped(self):
        run = run_task(MAGIC_LINK, [disconnected() for _ in range(MAX_RETRIES + 1)])

        assert [call.kwargs["countdown"] for call in run.retry.call_args_list] == BACKOFF_SCHEDULE


def run_with_smtp_backend(smtp, smtp_config=SMTP_CONFIG):
    """Run the magic-code task through Django's real SMTP backend, faking only `smtplib.SMTP`."""
    module = "plane.bgtasks.magic_link_code_task"
    with (
        override_settings(EMAIL_BACKEND=SMTP_BACKEND),
        patch(f"{module}.get_email_configuration", return_value=smtp_config),
        patch(f"{module}.log_exception") as log_exception,
        patch("django.core.mail.backends.smtp.smtplib.SMTP", smtp),
    ):
        magic_link.apply(args=MAGIC_LINK.args)
    return log_exception


@pytest.mark.unit
class TestNoDuplicateDelivery:
    @pytest.mark.parametrize(
        "quit_error",
        [
            pytest.param(disconnected(), id="server-disconnected"),
            pytest.param(ssl.SSLError("bad shutdown"), id="tls-error"),
        ],
    )
    def test_connection_loss_while_closing_after_send_does_not_resend(self, quit_error):
        assert_transient_failure_is_retried(MAGIC_LINK)

        client = MagicMock()
        client.sendmail.return_value = {}
        client.quit.side_effect = quit_error

        log_exception = run_with_smtp_backend(MagicMock(return_value=client))

        client.sendmail.assert_called_once()
        log_exception.assert_not_called()

    def test_failure_before_the_message_is_accepted_is_resent(self):
        client = MagicMock()
        client.sendmail.side_effect = [disconnected(), {}]

        run_with_smtp_backend(MagicMock(return_value=client))

        assert client.sendmail.call_count == 2


@pytest.mark.unit
class TestUnconfiguredSmtp:
    @pytest.mark.parametrize("host", ["", None])
    def test_refused_fallback_connection_is_not_retried(self, host):
        assert_transient_failure_is_retried(MAGIC_LINK)

        # Django connects to localhost when no host is configured.
        smtp = MagicMock(side_effect=ConnectionRefusedError(errno.ECONNREFUSED, "Connection refused"))

        log_exception = run_with_smtp_backend(smtp, smtp_config=(host, *SMTP_CONFIG[1:]))

        smtp.assert_called_once()
        assert smtp.call_args.args[0] == "localhost"
        log_exception.assert_called_once()


@pytest.mark.unit
class TestMagicCodeExpiry:
    @staticmethod
    def issue_code(fake_redis):
        fake_redis.eval.return_value = 1
        provider = MagicCodeProvider.__new__(MagicCodeProvider)
        provider.key = RECIPIENT
        return provider.initiate()

    def test_retries_resend_the_same_code_without_reissuing_it(self):
        fake_redis = MagicMock()
        with patch("plane.authentication.provider.credentials.magic_code.redis_instance", return_value=fake_redis):
            key, token = self.issue_code(fake_redis)
            run = run_task(EmailTask(MAGIC_LINK.module, magic_link, (RECIPIENT, key, token)), [disconnected(), 1])

        assert run.sends == 2
        assert all(token in subject for subject in subjects_sent(run))
        fake_redis.set.assert_called_once()
        assert fake_redis.set.call_args.kwargs["ex"] == 600
        fake_redis.expire.assert_not_called()

    def test_retry_window_ends_before_the_code_expires(self):
        fake_redis = MagicMock()
        with patch("plane.authentication.provider.credentials.magic_code.redis_instance", return_value=fake_redis):
            self.issue_code(fake_redis)
        run = run_task(MAGIC_LINK, [disconnected() for _ in range(MAX_RETRIES + 1)])

        retry_window = sum(call.kwargs["countdown"] for call in run.retry.call_args_list)

        assert retry_window == sum(BACKOFF_SCHEDULE)
        assert retry_window < fake_redis.set.call_args.kwargs["ex"]


@pytest.mark.unit
class TestNotificationErrorLogging:
    def test_task_error_goes_to_the_exception_logger_not_stdout(self, caplog, capsys):
        with caplog.at_level(logging.ERROR, logger="plane.exception"):
            result = notifications(
                type="issue.activity.created",
                issue_id="00000000-0000-0000-0000-000000000001",
                project_id="00000000-0000-0000-0000-000000000002",
                actor_id="00000000-0000-0000-0000-000000000003",
                subscriber=False,
                issue_activities_created="{not valid json",
                requested_data=None,
                current_instance=None,
            )

        assert result is None
        records = [record for record in caplog.records if record.name == "plane.exception"]
        assert len(records) == 1
        assert "Expecting property name" in records[0].getMessage()
        assert "Expecting property name" not in capsys.readouterr().out
