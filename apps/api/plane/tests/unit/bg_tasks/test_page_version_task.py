# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import json
from unittest.mock import patch

import pytest

from plane.bgtasks.page_version_task import track_page_version
from plane.db.models import Page, PageVersion

DESCRIPTION_JSON = {"type": "doc", "content": [{"type": "paragraph"}]}


@pytest.mark.unit
@pytest.mark.django_db
class TestTrackPageVersion:
    @pytest.fixture
    def page(self, workspace, create_user):
        return Page.objects.create(
            name="Roadmap",
            workspace=workspace,
            owned_by=create_user,
            description_html="<p>New text</p>",
            description_binary=b"new-binary",
            description_json=DESCRIPTION_JSON,
        )

    @patch("plane.bgtasks.page_version_task.log_exception")
    def test_records_a_new_version_when_the_description_changes(self, log_exception, page, create_user):
        track_page_version(str(page.id), json.dumps({"description_html": "<p>Old text</p>"}), str(create_user.id))

        log_exception.assert_not_called()
        version = PageVersion.objects.get(page=page)
        assert version.owned_by_id == create_user.id
        assert version.workspace_id == page.workspace_id
        assert version.description_html == "<p>New text</p>"
        assert version.description_json == DESCRIPTION_JSON

    @patch("plane.bgtasks.page_version_task.log_exception")
    def test_updates_the_authors_recent_version_instead_of_adding_one(self, log_exception, page, create_user):
        existing = PageVersion.objects.create(
            page=page,
            workspace=page.workspace,
            owned_by=create_user,
            description_html="<p>Old text</p>",
            description_json={"type": "doc"},
        )

        track_page_version(str(page.id), json.dumps({"description_html": "<p>Old text</p>"}), str(create_user.id))

        log_exception.assert_not_called()
        existing.refresh_from_db()
        assert PageVersion.objects.filter(page=page).count() == 1
        assert existing.description_html == "<p>New text</p>"
        assert existing.description_json == DESCRIPTION_JSON
