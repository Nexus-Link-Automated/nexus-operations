/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { CodingMachinesSettings } from "@/components/coding-machines/machines-settings";
import { ProfileSettingsHeading } from "@/components/settings/profile/heading";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserSettings } from "@/hooks/store/user";

/**
 * Machines belong to one workspace. The profile settings modal opens inside a workspace, so that one; on the
 * standalone /settings/profile/machines page, the workspace the user was last in.
 */
export const MachinesProfileSettings = observer(function MachinesProfileSettings() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const { currentWorkspace, getWorkspaceBySlug } = useWorkspace();
  const { data: settings } = useUserSettings();
  const workspace =
    [
      workspaceSlug?.toString(),
      currentWorkspace?.slug,
      settings?.workspace?.last_workspace_slug,
      settings?.workspace?.fallback_workspace_slug,
    ]
      .filter((slug): slug is string => !!slug)
      .map((slug) => getWorkspaceBySlug(slug))
      .find((found) => !!found) ?? null;

  if (!workspace) {
    return (
      <div className="flex size-full flex-col gap-4">
        <ProfileSettingsHeading title={t("coding_machines.title")} />
        <p className="text-body-sm-regular text-tertiary">{t("coding_machines.no_workspace")}</p>
      </div>
    );
  }

  return <CodingMachinesSettings key={workspace.slug} workspaceSlug={workspace.slug} workspaceName={workspace.name} />;
});
