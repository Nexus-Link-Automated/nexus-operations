/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { Badge } from "@makeplane/propel/components/badge";
import { Button } from "@makeplane/propel/components/button";
import { SelectField } from "@makeplane/propel/components/select-field";
import { SwitchField } from "@makeplane/propel/components/switch-field";
import { EmptyStateCompact } from "@plane/blocks/empty-state";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { InstanceChatService } from "@plane/services";
import type { TMessageExport, TMessageExportStatus } from "@plane/types";
// hooks
import { useWorkspace } from "@/hooks/store";
// local imports
import { formatSize } from "./helpers";

const chatService = new InstanceChatService();
const EXPORTS_KEY = "INSTANCE_MESSAGE_EXPORTS";
/** How often the list is read again while an export is being built. */
const POLL_MS = 5_000;

const STATUS_VARIANTS: Record<TMessageExportStatus, "neutral" | "info" | "success" | "danger" | "grey"> = {
  queued: "neutral",
  running: "info",
  ready: "success",
  failed: "danger",
  expired: "grey",
};

const inProgress = (exports: TMessageExport[] | undefined) =>
  !!exports?.some((item) => item.status === "queued" || item.status === "running");

function ExportRow({ item }: { item: TMessageExport }) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      // The link lasts about a minute, so it is asked for on the click, not with the list.
      window.location.assign(await chatService.downloadUrl(item.id));
    } catch {
      setToast({ type: "error", title: t("messages.admin.export.download_failed") });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="flex items-start justify-between gap-4 border-b border-subtle py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm-medium text-primary">{item.workspace_name}</span>
          <code className="text-caption-md-regular text-tertiary">{item.workspace_slug}</code>
          <Badge
            size="sm"
            variant={STATUS_VARIANTS[item.status]}
            label={t(`messages.admin.export.status.${item.status}`)}
          />
          <Badge
            size="sm"
            variant={item.include_private ? "warning" : "neutral"}
            label={t(item.include_private ? "messages.admin.export.scope_all" : "messages.admin.export.scope_public")}
          />
        </div>
        <p className="text-body-xs-regular text-secondary">
          {t("messages.admin.export.started_by", {
            email: item.requested_by_email,
            date: new Date(item.created_at).toLocaleString(),
          })}
        </p>
        {item.status === "ready" && (
          <p className="text-body-xs-regular text-tertiary">
            {t("messages.admin.export.contents", {
              channels: item.channel_count,
              messages: item.message_count,
              size: formatSize(item.size),
            })}
            {item.expires_at &&
              ` · ${t("messages.admin.export.expires", { date: new Date(item.expires_at).toLocaleString() })}`}
          </p>
        )}
      </div>
      {item.can_download && (
        <Button
          variant="secondary"
          size="md"
          stretch="auto"
          label={t("messages.admin.export.download")}
          aria-label={t("messages.admin.export.download_named", { name: item.workspace_name })}
          loading={downloading}
          onClick={() => void download()}
        />
      )}
    </li>
  );
}

/** Start an export of a workspace's messages, and the list of past exports. */
export const MessageExportSection = observer(function MessageExportSection({ expiryHours }: { expiryHours: number }) {
  const { t } = useTranslation();
  const { workspaceIds, getWorkspaceById, fetchWorkspaces, fetchNextWorkspaces, paginationInfo } = useWorkspace();
  useSWR("INSTANCE_WORKSPACES", () => fetchWorkspaces());
  const {
    data: exports,
    error,
    isLoading,
    mutate,
  } = useSWR(EXPORTS_KEY, () => chatService.listExports(), {
    refreshInterval: (latest) => (inProgress(latest) ? POLL_MS : 0),
  });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [includePrivate, setIncludePrivate] = useState(false);
  const [starting, setStarting] = useState(false);
  const hasMoreWorkspaces = paginationInfo?.next_page_results && paginationInfo?.next_cursor !== undefined;

  const start = async () => {
    if (!workspaceId) return;
    setStarting(true);
    try {
      const created = await chatService.createExport({ workspace_id: workspaceId, include_private: includePrivate });
      await mutate((current) => [created, ...(current ?? [])], { revalidate: false });
      setToast({ type: "success", title: t("messages.admin.export.started") });
      setIncludePrivate(false);
    } catch (caught) {
      const message = (caught as { error?: unknown } | undefined)?.error;
      setToast({
        type: "error",
        title: t("messages.admin.export.start_failed"),
        ...(typeof message === "string" ? { message } : {}),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="message-export-title">
      <div className="flex flex-col gap-1">
        <h3 id="message-export-title" className="text-body-md-medium text-primary">
          {t("messages.admin.export.title")}
        </h3>
        <p className="text-body-xs-regular text-secondary">
          {t("messages.admin.export.description", { hours: expiryHours })}
        </p>
      </div>
      <div className="flex max-w-xl flex-col gap-4">
        <SelectField<string>
          name="workspace"
          size="lg"
          label={t("messages.admin.export.workspace")}
          placeholder={t("messages.admin.export.workspace_placeholder")}
          value={workspaceId}
          options={workspaceIds.map((id) => {
            const workspace = getWorkspaceById(id);
            return { value: id, label: workspace ? `${workspace.name} (${workspace.slug})` : id };
          })}
          onValueChange={(value) => setWorkspaceId(value ?? null)}
        />
        {hasMoreWorkspaces && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              stretch="auto"
              label={t("messages.admin.export.more_workspaces")}
              onClick={() => void fetchNextWorkspaces()}
            />
          </div>
        )}
        <SwitchField
          name="include_private"
          size="lg"
          switchSize="md"
          label={t("messages.admin.export.include_private")}
          description={t("messages.admin.export.include_private_help")}
          checked={includePrivate}
          onCheckedChange={setIncludePrivate}
        />
        <div>
          <Button
            variant="primary"
            size="lg"
            stretch="auto"
            label={t("messages.admin.export.start")}
            disabled={!workspaceId || starting}
            loading={starting}
            onClick={() => void start()}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-body-sm-medium text-primary">{t("messages.admin.export.history")}</h4>
        {isLoading && !exports ? null : error && !exports ? (
          <EmptyStateCompact
            title={t("messages.admin.export.load_failed")}
            align="start"
            actions={[{ label: t("messages.admin.retry"), variant: "secondary", onClick: () => void mutate() }]}
          />
        ) : !exports?.length ? (
          <p className="text-body-xs-regular text-tertiary">{t("messages.admin.export.empty")}</p>
        ) : (
          <ul aria-label={t("messages.admin.export.history")}>
            {exports.map((item) => (
              <ExportRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
});
