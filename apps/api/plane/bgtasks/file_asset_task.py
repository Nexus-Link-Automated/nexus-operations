# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import os
from datetime import timedelta

# Django imports
from django.utils import timezone
from django.db.models import Q

# Third party imports
from celery import shared_task

# Module imports
from plane.db.models import FileAsset


@shared_task
def delete_unuploaded_file_asset():
    """This task deletes file assets older than a certain number of days that were never finished.

    That's an upload that never completed, or a message attachment uploaded but never sent.
    """
    never_sent = Q(entity_type=FileAsset.EntityTypeContext.CHAT_MESSAGE_ATTACHMENT, entity_identifier__isnull=True)
    FileAsset.objects.filter(
        Q(created_at__lt=timezone.now() - timedelta(days=int(os.environ.get("UNUPLOADED_ASSET_DELETE_DAYS", "7"))))
        & (Q(is_uploaded=False) | never_sent)
    ).delete()
