# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import base64

import pytest

from plane.app.serializers.page import PageBinaryUpdateSerializer
from plane.utils.content_validator import validate_binary_data

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
