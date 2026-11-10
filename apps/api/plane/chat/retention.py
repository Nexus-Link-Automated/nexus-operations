# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Deleting messages once they are older than the instance's retention setting, and the files left behind.

God mode sets `CHAT_MESSAGE_RETENTION_DAYS`, an `InstanceConfiguration`: 0, the default, keeps messages forever;
anything else is at least `MIN_RETENTION_DAYS`. Every day `purge_chat_data` hard deletes, at most `BATCH_SIZE`
messages per transaction so that no lock is held for long:

1. thread replies older than the cutoff;
2. top-level messages older than the cutoff with no replies left;
3. and empties the top-level messages older than the cutoff whose thread still has newer replies, the way a removal
   does (`removed_at` set; body, references, inbox entries and files gone), so the replies keep a thread to hang off.
   Deleting it would delete them too, though they are younger than the setting. The empty row goes in step 2 of a
   later run, once its last reply is past the cutoff as well.

Removed messages go the same way: they are messages like any other.

With a message go its work item references (`MessageReference`, the project feed's included) and any mention still
queued for the digest (`PendingMentionEmail`), by cascade; its inbox entries (`Notification`, which refer to it only
by ID); and its attachments, storage objects first and `FileAsset` rows after, so that a failure leaves rows to retry
rather than objects nothing refers to. A read cursor on a deleted message is cleared (`SET_NULL`), which keeps unread
counts right: whatever is left from before the cutoff is a removed message, which never counts as unread, and every
message after it is newer than the deleted cursor, so unread either way.

A work item's link to a message it was created from (`IssueLink`) belongs to the work item and stays; it opens a
"no longer available" page once the message is gone.

Nothing is announced to the chat gateway. These messages are at least `MIN_RETENTION_DAYS` old, so an open client
seldom holds one, and a client that does gets the same 404 as for any message it can no longer see when it next
asks for it. A reload drops it.

Whatever the setting, each run also purges the attachments that are gone for users but still in storage: those of
removed messages and discarded uploads (soft deleted), those of deleted channels, and uploads never sent within
`UNUPLOADED_ASSET_DELETE_DAYS`.
"""

import logging
import os
from datetime import timedelta
from itertools import batched

from celery import shared_task
from django.db import transaction
from django.db.models import Exists, OuterRef, Q, TextField
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast
from django.utils import timezone

from plane.chat.models import Channel, Message, MessageReference, PendingMentionEmail
from plane.chat.notifications import CHAT_MESSAGE_ENTITY
from plane.db.models import FileAsset, Notification
from plane.license.utils.instance_value import get_configuration_value
from plane.settings.storage import S3Storage
from plane.utils.exception_logger import log_exception

logger = logging.getLogger("plane.worker")

RETENTION_KEY = "CHAT_MESSAGE_RETENTION_DAYS"
MIN_RETENTION_DAYS = 30
MAX_RETENTION_DAYS = 36500
BATCH_SIZE = 500
# The most keys one S3 DeleteObjects call takes.
STORAGE_DELETE_LIMIT = 1000


class StorageDeleteError(Exception):
    pass


def parse_retention_days(value):
    """`value` as a retention setting: 0 to keep messages forever, or a number of days. ValueError if it isn't one."""
    text = "" if value is None else str(value).strip()
    if not text:
        return 0
    if not text.isdecimal() or len(text) > 6:
        raise ValueError("Enter a whole number of days.")
    days = int(text)
    if days != 0 and not MIN_RETENTION_DAYS <= days <= MAX_RETENTION_DAYS:
        raise ValueError(
            f"Keep messages for {MIN_RETENTION_DAYS} to {MAX_RETENTION_DAYS} days, or 0 to keep them forever."
        )
    return days


def retention_days():
    """The instance's setting, in days; 0 keeps messages forever. So does a stored value that isn't a valid one."""
    (value,) = get_configuration_value([{"key": RETENTION_KEY, "default": os.environ.get(RETENTION_KEY, "0")}])
    try:
        return parse_retention_days(value)
    except ValueError:
        logger.warning("%s: ignoring invalid value %r; keeping messages", RETENTION_KEY, value)
        return 0


def _chat_assets():
    """Every message attachment row, soft deleted or not."""
    return FileAsset.all_objects.filter(entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT)


def delete_storage_objects(keys):
    """Delete these objects from storage, or raise. Deleting one that isn't there succeeds."""
    keys = [key for key in keys if key]
    if not keys:
        return
    storage = S3Storage()
    for chunk in batched(keys, STORAGE_DELETE_LIMIT):
        response = storage.s3_client.delete_objects(
            Bucket=storage.aws_storage_bucket_name,
            Delete={"Objects": [{"Key": key} for key in chunk], "Quiet": True},
        )
        if response.get("Errors"):
            raise StorageDeleteError(f"{len(response['Errors'])} storage objects could not be deleted")


def _purge_assets(assets):
    """Delete up to `BATCH_SIZE` of these attachments, storage objects then rows. Returns how many went."""
    batch = list(assets.values_list("id", "asset")[:BATCH_SIZE])
    delete_storage_objects([key for _, key in batch])
    deleted, _ = FileAsset.all_objects.filter(pk__in=[pk for pk, _ in batch]).delete()
    return len(batch) if deleted else 0


def orphaned_attachments(now):
    """Attachments no one can reach any more: soft deleted, in a deleted channel, or uploaded and never sent.

    One queryset each, so that each stays a simple scan or anti-join.
    """
    live_channel = Channel.objects.annotate(id_text=Cast("id", TextField())).filter(id_text=OuterRef("channel_text"))
    never_sent_before = now - timedelta(days=int(os.environ.get("UNUPLOADED_ASSET_DELETE_DAYS", "7")))
    return [
        _chat_assets().filter(Q(is_deleted=True) | Q(deleted_at__isnull=False)),
        _chat_assets()
        .annotate(channel_text=KeyTextTransform("channel_id", "attributes"))
        .exclude(Exists(live_channel)),
        _chat_assets().filter(entity_identifier__isnull=True, created_at__lt=never_sent_before),
    ]


def _forget(message_ids):
    """Delete what refers to these messages by ID only: their attachments (storage first) and inbox entries."""
    as_text = [str(pk) for pk in message_ids]
    attachments = list(_chat_assets().filter(entity_identifier__in=as_text).values_list("id", "asset"))
    delete_storage_objects([key for _, key in attachments])
    FileAsset.all_objects.filter(pk__in=[pk for pk, _ in attachments]).delete()
    Notification.all_objects.filter(entity_name=CHAT_MESSAGE_ENTITY, entity_identifier__in=message_ids).delete()


def _has_replies():
    return Exists(Message.all_objects.filter(parent=OuterRef("pk")))


def _delete_batch(candidates):
    """Hard delete up to `BATCH_SIZE` of `candidates`. Returns how many it looked at, 0 once none are left."""
    ids = list(candidates.values_list("id", flat=True)[:BATCH_SIZE])
    if not ids:
        return 0
    with transaction.atomic():
        # Locked, and checked again, so a reply that arrives meanwhile isn't deleted with a message it joined. One
        # that did no longer matches `candidates`, so the next batch doesn't pick it up again.
        locked = list(candidates.filter(pk__in=ids).select_for_update().values_list("id", flat=True))
        # Read again now the rows are locked. A reply whose insert was under way when the lock was taken made it
        # wait, and is committed now, but the locking read's snapshot predates it. No reply can be added while the
        # locks are held, so this read sees every one.
        locked = list(candidates.filter(pk__in=locked).values_list("id", flat=True))
        _forget(locked)
        Message.all_objects.filter(pk__in=locked).delete()
    return len(ids)


def _empty_batch(candidates, now):
    """Empty up to `BATCH_SIZE` of `candidates` the way a removal does. Returns how many."""
    with transaction.atomic():
        ids = list(candidates.select_for_update().values_list("id", flat=True)[:BATCH_SIZE])
        if not ids:
            return 0
        _forget(ids)
        MessageReference.all_objects.filter(message_id__in=ids).delete()
        PendingMentionEmail.objects.filter(message_id__in=ids).delete()
        Message.all_objects.filter(pk__in=ids).update(
            body_html="", body_json={}, body_stripped="", removed_at=now, updated_at=now
        )
    return len(ids)


def _run(step, *args):
    """Run `step` until it has nothing left. A failure is logged and ends this step only, for the next run to retry."""
    done = 0
    try:
        while count := step(*args):
            done += count
    except Exception as error:
        log_exception(error)
    return done


def purge_expired_messages(cutoff, now):
    """Delete or empty the messages from before `cutoff`, as the module docstring says. Returns the counts."""
    old = Message.all_objects.filter(created_at__lt=cutoff)
    return {
        "replies": _run(_delete_batch, old.filter(parent__isnull=False)),
        "messages": _run(_delete_batch, old.filter(parent__isnull=True).exclude(_has_replies())),
        "emptied": _run(_empty_batch, old.filter(parent__isnull=True, removed_at__isnull=True), now),
    }


@shared_task
def purge_chat_data():
    """The daily run: messages past the retention setting, if there is one, then attachments nobody can reach."""
    now = timezone.now()
    days = retention_days()
    counts = purge_expired_messages(now - timedelta(days=days), now) if days else {}
    counts["attachments"] = sum(_run(_purge_assets, assets) for assets in orphaned_attachments(now))
    logger.info("chat retention: %s days, %s", days or "forever", counts)
    return counts
