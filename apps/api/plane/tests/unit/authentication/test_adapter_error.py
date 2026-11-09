# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest

from plane.authentication.adapter.error import AuthenticationException


@pytest.mark.unit
class TestAuthenticationException:
    def test_error_dict_without_payload_has_only_code_and_message(self):
        error = AuthenticationException(error_code=5000, error_message="FAILED")

        assert error.get_error_dict() == {"error_code": 5000, "error_message": "FAILED"}

    def test_error_dict_includes_payload_keys(self):
        error = AuthenticationException(error_code=5000, error_message="FAILED", payload={"email": "a@example.com"})

        assert error.get_error_dict() == {"error_code": 5000, "error_message": "FAILED", "email": "a@example.com"}

    def test_default_payload_is_not_shared_between_instances(self):
        first = AuthenticationException(error_code=5000, error_message="FAILED")
        second = AuthenticationException(error_code=5000, error_message="FAILED")

        first.payload["email"] = "a@example.com"

        assert second.payload == {}
