# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import base64
from unittest import mock

import pytest

from plane.app.serializers.page import PageBinaryUpdateSerializer
from plane.utils import content_validator
from plane.utils.content_validator import validate_binary_data, validate_html_content

# Base64 of Y.encodeStateAsUpdate() for a page with one paragraph holding the keyed text.
YJS_PAGE_UPDATES = {
    "Metadata: Q3 plan": "AQOF1YiDBAAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAIXViIMEAAYEAIXViIMEARFNZXRhZGF0YTogUTMgcGxhbgA=",
    "Data: quarterly numbers": (
        "AQPDhfPvCwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAMOF8+8LAAYEAMOF8+8LARdEYXRhOiBxdWFydGVybHkgbnVtYmVycwA="
    ),
    "How to fix javascript: links": (
        "AQP3h78sAAcBB2RlZmF1bHQDCXBhcmFncmFwaAcA94e/LAAGBAD3h78sARxIb3cgdG8gZml4IGphdmFzY3JpcHQ6IGxpbmtzAA=="
    ),
    "<html> basics for beginners": (
        "AQPD4rSeCAAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAMPitJ4IAAYEAMPitJ4IARs8aHRtbD4gYmFzaWNzIGZvciBiZWdpbm5lcnMA"
    ),
}


@pytest.mark.unit
class TestValidateBinaryData:
    @pytest.mark.parametrize("page_text", YJS_PAGE_UPDATES)
    def test_accepts_page_text_that_resembles_markup_or_a_url_scheme(self, page_text):
        update = base64.b64decode(YJS_PAGE_UPDATES[page_text])
        assert page_text.encode() in update

        assert validate_binary_data(update) == (True, None)

    @pytest.mark.parametrize("page_text", YJS_PAGE_UPDATES)
    def test_accepts_the_same_page_text_when_base64_encoded(self, page_text):
        assert validate_binary_data(YJS_PAGE_UPDATES[page_text]) == (True, None)

    @pytest.mark.parametrize("page_text", YJS_PAGE_UPDATES)
    def test_page_save_payload_is_valid(self, page_text):
        update = YJS_PAGE_UPDATES[page_text]
        serializer = PageBinaryUpdateSerializer(data={"description_binary": update})

        assert serializer.is_valid(), serializer.errors
        assert serializer.validated_data["description_binary"] == base64.b64decode(update)


@pytest.mark.unit
class TestValidateHtmlContent:
    def test_skips_the_removal_diff_when_sanitising_changed_nothing(self):
        html = "<p>hello <strong>world</strong></p>"
        with mock.patch.object(
            content_validator,
            "_compute_html_sanitization_diff",
            wraps=content_validator._compute_html_sanitization_diff,
        ) as compute_diff:
            assert validate_html_content(html) == (True, None, html)

        compute_diff.assert_not_called()

    def test_logs_removals_when_sanitising_stripped_content(self):
        html = '<p onclick="x()">hello</p><script>alert(1)</script>'
        with mock.patch.object(content_validator.logger, "warning") as warning:
            is_valid, error, clean_html = validate_html_content(html)

        assert (is_valid, error) == (True, None)
        assert "script" not in clean_html
        warning.assert_called_once()
        assert "script" in warning.call_args.args[0]
        assert "onclick" in warning.call_args.args[0]
