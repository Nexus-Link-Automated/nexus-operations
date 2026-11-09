# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from .base import BaseSerializer
from plane.license.models import InstanceConfiguration
from plane.license.utils.encryption import decrypt_data

# Returned in place of an encrypted value that is set. Sending it back keeps the saved value.
INSTANCE_CONFIGURATION_MASK = "********"


class InstanceConfigurationSerializer(BaseSerializer):
    class Meta:
        model = InstanceConfiguration
        fields = "__all__"

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # Encrypted values are write-only: report whether one is set, never what it is
        if instance.is_encrypted and instance.value is not None:
            data["value"] = INSTANCE_CONFIGURATION_MASK if decrypt_data(instance.value) else ""

        return data
