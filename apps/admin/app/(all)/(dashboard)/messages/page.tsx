/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import useSWR from "swr";
// plane imports
import { EmptyStateCompact } from "@plane/blocks/empty-state";
import { Skeleton } from "@plane/blocks/skeleton";
import { useTranslation } from "@plane/i18n";
import { InstanceChatService } from "@plane/services";
// components
import { PageWrapper } from "@/components/common/page-wrapper";
// types
import type { Route } from "./+types/page";
// local imports
import { MessageExportSection } from "./export-section";
import { MessageRateLimits } from "./rate-limits";
import { MessageRetentionForm } from "./retention-form";

const chatService = new InstanceChatService();
const SETTINGS_KEY = "INSTANCE_CHAT_SETTINGS";

function InstanceMessagesPage(_props: Route.ComponentProps) {
  const { t } = useTranslation();
  const { data: settings, error, mutate } = useSWR(SETTINGS_KEY, () => chatService.settings());

  const saveRetention = async (retentionDays: number) => {
    const saved = await chatService.updateSettings({ retention_days: retentionDays });
    await mutate(saved, { revalidate: false });
  };

  return (
    <PageWrapper header={{ title: t("messages.admin.title"), description: t("messages.admin.description") }}>
      {!settings && error ? (
        <EmptyStateCompact
          title={t("messages.admin.load_failed")}
          align="start"
          actions={[{ label: t("messages.admin.retry"), variant: "secondary", onClick: () => void mutate() }]}
        />
      ) : !settings ? (
        <Skeleton className="space-y-4">
          <Skeleton.Item height="64px" width="100%" />
          <Skeleton.Item height="120px" width="100%" />
        </Skeleton>
      ) : (
        <div className="flex flex-col gap-10">
          {/* Keyed on the saved value, so the form starts again from it after a save. */}
          <MessageRetentionForm key={settings.retention_days} settings={settings} onSave={saveRetention} />
          <MessageExportSection expiryHours={settings.export_expiry_hours} />
          <MessageRateLimits limits={settings.rate_limits} />
        </div>
      )}
    </PageWrapper>
  );
}

export const meta: Route.MetaFunction = () => [{ title: "Messages - God Mode" }];

export default InstanceMessagesPage;
