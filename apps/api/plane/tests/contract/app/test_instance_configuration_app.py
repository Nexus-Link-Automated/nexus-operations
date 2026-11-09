# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the instance settings admin endpoints.

GET/PATCH /api/instances/configurations/
DELETE /api/instances/configurations/disable-email-feature/

Encrypted settings are write-only: reads say whether a value is set, and sending
the mask back on PATCH keeps the saved value.
"""

import uuid

import pytest
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework import status

from plane.license.api.serializers import INSTANCE_CONFIGURATION_MASK
from plane.license.models import Instance, InstanceAdmin, InstanceConfiguration
from plane.license.utils.encryption import decrypt_data, encrypt_data
from plane.license.utils.instance_value import get_email_configuration

CONFIGURATIONS_URL = "/api/instances/configurations/"
DISABLE_EMAIL_URL = "/api/instances/configurations/disable-email-feature/"
SAVED_PASSWORD = "saved-smtp-password"


@pytest.fixture(autouse=True)
def clear_configurations_cache():
    cache.delete(CONFIGURATIONS_URL)
    yield
    cache.delete(CONFIGURATIONS_URL)


@pytest.fixture
def instance(db):
    instance = Instance.objects.first()
    if instance is None:
        instance = Instance.objects.create(
            instance_name="Test Instance",
            instance_id=str(uuid.uuid4()),
            current_version="1.0.0",
            domain="http://localhost:8000",
            last_checked_at=timezone.now(),
            is_setup_done=True,
        )
    return instance


@pytest.fixture
def admin_client(session_client, create_user, instance):
    InstanceAdmin.objects.create(instance=instance, user=create_user, role=20)
    return session_client


def _make_setting(key, value, is_encrypted=False):
    stored = encrypt_data(value) if is_encrypted else value
    return InstanceConfiguration.objects.create(key=key, value=stored, category="TEST", is_encrypted=is_encrypted)


@pytest.fixture
def email_settings(db):
    return {
        "EMAIL_HOST": _make_setting("EMAIL_HOST", "smtp.example.com"),
        "ENABLE_SMTP": _make_setting("ENABLE_SMTP", "1"),
        "EMAIL_HOST_PASSWORD": _make_setting("EMAIL_HOST_PASSWORD", SAVED_PASSWORD, is_encrypted=True),
    }


def _values(response):
    return {item["key"]: item["value"] for item in response.data}


def _stored(key):
    return InstanceConfiguration.objects.get(key=key).value


@pytest.mark.contract
class TestInstanceConfigurationRead:
    @pytest.mark.django_db
    def test_encrypted_value_that_is_set_is_returned_as_the_mask(self, admin_client, email_settings):
        response = admin_client.get(CONFIGURATIONS_URL)

        assert response.status_code == status.HTTP_200_OK
        assert _values(response)["EMAIL_HOST_PASSWORD"] == INSTANCE_CONFIGURATION_MASK
        assert SAVED_PASSWORD not in str(response.content)

    @pytest.mark.django_db
    def test_plain_values_are_returned_as_stored(self, admin_client, email_settings):
        values = _values(admin_client.get(CONFIGURATIONS_URL))

        assert values["EMAIL_HOST"] == "smtp.example.com"
        assert values["ENABLE_SMTP"] == "1"

    @pytest.mark.django_db
    def test_encrypted_value_that_is_empty_is_reported_as_not_set(self, admin_client):
        _make_setting("LLM_API_KEY", "", is_encrypted=True)

        assert _values(admin_client.get(CONFIGURATIONS_URL))["LLM_API_KEY"] == ""

    @pytest.mark.django_db
    def test_value_that_cannot_be_decrypted_is_reported_as_not_set(self, admin_client):
        InstanceConfiguration.objects.create(
            key="LLM_API_KEY", value="not-a-fernet-token", category="TEST", is_encrypted=True
        )

        assert _values(admin_client.get(CONFIGURATIONS_URL))["LLM_API_KEY"] == ""


@pytest.mark.contract
class TestInstanceConfigurationSave:
    @pytest.mark.django_db
    def test_untouched_mask_keeps_the_saved_value(self, admin_client, email_settings):
        ciphertext = _stored("EMAIL_HOST_PASSWORD")
        values = _values(admin_client.get(CONFIGURATIONS_URL))

        response = admin_client.patch(
            CONFIGURATIONS_URL,
            {"EMAIL_HOST": "smtp.changed.example.com", "EMAIL_HOST_PASSWORD": values["EMAIL_HOST_PASSWORD"]},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        assert _stored("EMAIL_HOST") == "smtp.changed.example.com"
        assert _stored("EMAIL_HOST_PASSWORD") == ciphertext
        assert decrypt_data(_stored("EMAIL_HOST_PASSWORD")) == SAVED_PASSWORD
        assert _values(response)["EMAIL_HOST_PASSWORD"] == INSTANCE_CONFIGURATION_MASK

    @pytest.mark.django_db
    def test_mask_never_becomes_the_saved_value_of_an_empty_setting(self, admin_client):
        _make_setting("LLM_API_KEY", "", is_encrypted=True)

        response = admin_client.patch(CONFIGURATIONS_URL, {"LLM_API_KEY": INSTANCE_CONFIGURATION_MASK}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert _stored("LLM_API_KEY") == ""
        assert _values(response)["LLM_API_KEY"] == ""

    @pytest.mark.django_db
    def test_new_value_is_stored_encrypted_and_returned_masked(self, admin_client, email_settings):
        response = admin_client.patch(CONFIGURATIONS_URL, {"EMAIL_HOST_PASSWORD": "new-password"}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert _stored("EMAIL_HOST_PASSWORD") != "new-password"
        assert decrypt_data(_stored("EMAIL_HOST_PASSWORD")) == "new-password"
        assert _values(response)["EMAIL_HOST_PASSWORD"] == INSTANCE_CONFIGURATION_MASK
        assert "new-password" not in str(response.content)

    @pytest.mark.django_db
    @pytest.mark.parametrize("cleared", ["", None, "   "])
    def test_cleared_value_is_cleared(self, admin_client, email_settings, cleared):
        response = admin_client.patch(CONFIGURATIONS_URL, {"EMAIL_HOST_PASSWORD": cleared}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert _stored("EMAIL_HOST_PASSWORD") == ""
        assert _values(response)["EMAIL_HOST_PASSWORD"] == ""

        # A form still holding the mask from before the clear does not bring a value back
        admin_client.patch(CONFIGURATIONS_URL, {"EMAIL_HOST_PASSWORD": INSTANCE_CONFIGURATION_MASK}, format="json")
        assert _stored("EMAIL_HOST_PASSWORD") == ""

    @pytest.mark.django_db
    @override_settings(SKIP_ENV_VAR=True)
    def test_server_side_readers_get_the_decrypted_saved_value(self, admin_client, email_settings):
        admin_client.patch(CONFIGURATIONS_URL, {"EMAIL_HOST_PASSWORD": INSTANCE_CONFIGURATION_MASK}, format="json")

        _host, _user, password, *_rest = get_email_configuration()
        assert password == SAVED_PASSWORD


@pytest.mark.contract
class TestInstanceConfigurationCache:
    @pytest.mark.django_db
    def test_cache_holds_no_readable_value_after_a_read(self, admin_client, email_settings):
        admin_client.get(CONFIGURATIONS_URL)

        cached = cache.get(CONFIGURATIONS_URL)
        assert cached is None or SAVED_PASSWORD not in str(cached)

    @pytest.mark.django_db
    def test_read_after_a_save_returns_the_new_values(self, admin_client, email_settings):
        admin_client.get(CONFIGURATIONS_URL)

        admin_client.patch(CONFIGURATIONS_URL, {"EMAIL_HOST": "smtp.changed.example.com"}, format="json")

        assert _values(admin_client.get(CONFIGURATIONS_URL))["EMAIL_HOST"] == "smtp.changed.example.com"

    @pytest.mark.django_db
    def test_read_after_disabling_email_returns_the_cleared_values(self, admin_client, email_settings):
        admin_client.get(CONFIGURATIONS_URL)

        assert admin_client.delete(DISABLE_EMAIL_URL).status_code == status.HTTP_200_OK

        values = _values(admin_client.get(CONFIGURATIONS_URL))
        assert values["ENABLE_SMTP"] == "0"
        assert values["EMAIL_HOST"] == ""
        assert values["EMAIL_HOST_PASSWORD"] == ""
