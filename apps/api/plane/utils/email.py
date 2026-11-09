# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import html
import re
import smtplib
import socket
import ssl

# Django imports
from django.utils.html import strip_tags

# Third party imports
from celery.utils.time import get_exponential_backoff_interval

_STYLE_OPEN_RE = re.compile(r"<style", re.IGNORECASE)
_STYLE_CLOSE_RE = re.compile(r"</style>", re.IGNORECASE)

# Retry schedule for emails a user is waiting on: 10s, 20s, 40s, then 80s. The
# 150s total rides out a brief SMTP outage and stays well inside the 10 minute
# lifetime of a magic code.
EMAIL_TASK_MAX_RETRIES = 4
EMAIL_RETRY_BACKOFF_SECONDS = 10
EMAIL_RETRY_BACKOFF_MAX_SECONDS = 80


def is_transient_email_error(exc):
    """Return True only for delivery failures that can succeed on a later attempt."""
    # Every smtplib exception is also an OSError, so these checks come first.
    if isinstance(exc, smtplib.SMTPServerDisconnected):
        return True
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        codes = [code for code, _ in exc.recipients.values()]
        return bool(codes) and all(400 <= code < 500 for code in codes)
    if isinstance(exc, smtplib.SMTPResponseException):
        return 400 <= exc.smtp_code < 500
    # Other smtplib errors (such as missing STARTTLS support) and TLS failures
    # (such as a bad certificate or the wrong port) need a configuration change.
    if isinstance(exc, (smtplib.SMTPException, ssl.SSLError)):
        return False
    # A host that does not resolve is misconfigured, unless the resolver asked us to try again.
    if isinstance(exc, socket.gaierror):
        return exc.errno == socket.EAI_AGAIN
    # Connection refused or reset, timeouts, and unreachable networks.
    return isinstance(exc, OSError)


def send_email_with_retry(task, message, email_host):
    """
    Send ``message`` from a bound Celery task, retrying transient delivery failures.

    Only a failed ``message.send()`` can schedule a retry, so a message the server
    has accepted is never sent again. Permanent failures and the last failed
    attempt are re-raised for the task to log.

    Args:
        task: The bound Celery task sending the message
        message: The Django email message to send
        email_host: The configured SMTP host, which is empty when SMTP is unconfigured
    """
    try:
        message.send()
    except Exception as exc:
        # Without a host Django falls back to localhost, so a refused connection
        # means SMTP is unconfigured rather than temporarily down.
        if email_host and is_transient_email_error(exc) and task.request.retries < task.max_retries:
            raise task.retry(
                exc=exc,
                countdown=get_exponential_backoff_interval(
                    factor=EMAIL_RETRY_BACKOFF_SECONDS,
                    retries=task.request.retries,
                    maximum=EMAIL_RETRY_BACKOFF_MAX_SECONDS,
                ),
            )
        raise


def _remove_style_blocks(html_content):
    """
    Remove `<style ...>...</style>` blocks (case-insensitive) in a single
    forward scan, leaving the surrounding content unchanged.
    """
    parts = []
    pos = 0
    while start := _STYLE_OPEN_RE.search(html_content, pos):
        tag_end = html_content.find(">", start.end())
        if tag_end == -1:
            break
        close = _STYLE_CLOSE_RE.search(html_content, tag_end + 1)
        if close is None:
            break
        parts.append(html_content[pos : start.start()])
        pos = close.end()
    parts.append(html_content[pos:])
    return "".join(parts)


def generate_plain_text_from_html(html_content):
    """
    Generate clean plain text from HTML email template.
    Removes all HTML tags, CSS styles, and excessive whitespace, and decodes
    HTML character references so the text/plain part reads as literal text.

    Args:
        html_content (str): The HTML content to convert to plain text

    Returns:
        str: Clean plain text without HTML tags, styles, excessive whitespace,
            or HTML character references
    """
    # Remove style tags and their content
    html_content = _remove_style_blocks(html_content)

    # Strip HTML tags, then decode character references. `strip_tags` re-emits
    # entity refs verbatim, so URLs escaped for the HTML part would otherwise
    # reach the text/plain part as `?a=1&amp;b=2` and break when pasted.
    text_content = html.unescape(strip_tags(html_content))

    # Remove excessive empty lines
    text_content = re.sub(r"\n\s*\n\s*\n+", "\n\n", text_content)

    # Ensure there's a leading and trailing whitespace
    text_content = "\n\n" + text_content.lstrip().rstrip() + "\n\n"

    return text_content
