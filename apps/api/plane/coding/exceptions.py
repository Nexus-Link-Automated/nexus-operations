# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Errors the coding services raise. The views turn each into `{"error": ..., "code": ...}` with its status."""

from rest_framework import status


class CodingError(Exception):
    http_status = status.HTTP_400_BAD_REQUEST
    code = None

    def __init__(self, message: str, *, code: str | None = None, extra: dict | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.extra = extra or {}

    def body(self) -> dict:
        body = {"error": self.message}
        if self.code:
            body["code"] = self.code
        body.update(self.extra)
        return body


class NotConfigured(CodingError):
    code = "CODING_NOT_CONFIGURED"


class Forbidden(CodingError):
    http_status = status.HTTP_403_FORBIDDEN


class NotFound(CodingError):
    http_status = status.HTTP_404_NOT_FOUND


class Conflict(CodingError):
    http_status = status.HTTP_409_CONFLICT


class InvalidResult(CodingError):
    """A result that does not match the schema for the job's action. `errors` maps each field to what is wrong."""

    code = "INVALID_RESULT"

    def __init__(self, errors):
        super().__init__("The result is not valid for this job.", extra={"errors": errors})
        self.errors = errors
