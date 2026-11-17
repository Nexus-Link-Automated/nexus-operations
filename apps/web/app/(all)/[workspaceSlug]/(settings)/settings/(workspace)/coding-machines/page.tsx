/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// components
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { CodingMachinesAdmin } from "@/components/coding-machines/admin-machines";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { SettingsHeading } from "@/components/settings/heading";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";
// local imports
import type { Route } from "./+types/page";
import { CodingMachinesWorkspaceSettingsHeader } from "./header";

function CodingMachinesSettingsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { t } = useTranslation();
  // store hooks
  const { workspaceUserInfo, allowPermissions } = useUserPermissions();
  const { currentWorkspace } = useWorkspace();
  // derived values
  const isWorkspaceAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const pageTitle = currentWorkspace?.name
    ? `${currentWorkspace.name} - ${t("coding_machines.admin.title")}`
    : undefined;

  if (workspaceUserInfo && !isWorkspaceAdmin) {
    return <NotAuthorizedView section="settings" className="h-auto" />;
  }

  return (
    <SettingsContentWrapper header={<CodingMachinesWorkspaceSettingsHeader />}>
      <PageHead title={pageTitle} />
      <div className="flex w-full flex-col gap-6">
        <SettingsHeading
          title={t("coding_machines.admin.title")}
          description={t("coding_machines.admin.description")}
        />
        {isWorkspaceAdmin && <CodingMachinesAdmin key={workspaceSlug} workspaceSlug={workspaceSlug} />}
      </div>
    </SettingsContentWrapper>
  );
}

export default observer(CodingMachinesSettingsPage);
