# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""BaseModel.save with no request user, as in Celery workers and management commands."""

import pytest
from crum import impersonate
from django.contrib.auth.models import AnonymousUser

from plane.db.models import Label, User

pytestmark = pytest.mark.unit


@pytest.fixture
def author(create_user):
    return create_user


@pytest.fixture
def editor(db):
    return User.objects.create(email="editor@plane.so", username="editor")


@pytest.fixture
def label(workspace):
    return Label.objects.create(name="audited", workspace=workspace)


def _attribute(label, author, editor):
    Label.objects.filter(pk=label.pk).update(created_by=author, updated_by=editor)
    return Label.objects.get(pk=label.pk)


@pytest.mark.parametrize("request_user", [None, AnonymousUser()], ids=["no-user", "anonymous"])
def test_save_without_a_user_keeps_existing_attribution(label, author, editor, request_user):
    row = _attribute(label, author, editor)

    with impersonate(request_user):
        row.save()

    row.refresh_from_db()
    assert row.created_by_id == author.id
    assert row.updated_by_id == editor.id


def test_new_row_starts_unattributed_and_keeps_its_last_editor(workspace, editor):
    with impersonate(None):
        row = Label.objects.create(name="from-a-worker", workspace=workspace)
    row.refresh_from_db()
    assert row.created_by_id is None
    assert row.updated_by_id is None

    with impersonate(editor):
        row.save()
    with impersonate(None):
        row.save()

    row.refresh_from_db()
    assert row.created_by_id is None
    assert row.updated_by_id == editor.id


def test_created_by_id_argument_survives_a_later_background_save(label, author, editor):
    row = _attribute(label, author, editor)

    with impersonate(None):
        row.save(created_by_id=editor.id)
        row.save()

    row.refresh_from_db()
    assert row.created_by_id == editor.id
    assert row.updated_by_id == editor.id


def test_disable_auto_set_user_value_survives_a_later_background_save(label, author, editor):
    row = _attribute(label, author, editor)

    with impersonate(None):
        row.created_by = editor
        row.save(disable_auto_set_user=True)
        row.save()

    row.refresh_from_db()
    assert row.created_by_id == editor.id
    assert row.updated_by_id == editor.id
