/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Badge } from "@makeplane/propel/components/badge";
import { Button } from "@makeplane/propel/components/button";
import { ConfirmDialog } from "@plane/blocks/dialog";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TBotMember, TBotMemberCreate, TBotMemberUpdate } from "@plane/types";
import { calculateTimeAgo, renderFormattedDate } from "@plane/utils";
// components
import type { DataTableColumn } from "@/components/common/data-table";
import { DataTable } from "@/components/common/data-table";
// hooks
import { useBotMember } from "@/hooks/store/use-bot-member";
import { useMember } from "@/hooks/store/use-member";
// local imports
import { codingErrorMessage } from "../coding-jobs/helpers";
import { BotMemberFormDialog } from "./bot-member-form-dialog";
import { botRoleKey } from "./helpers";
import { BotTokenDialog } from "./token-dialog";

type Props = {
  workspaceSlug: string;
};

type TDialog =
  | { kind: "create" }
  | { kind: "edit" | "token" | "remove"; bot: TBotMember }
  | { kind: "show_token"; botName: string; token: string };

/**
 * Workspace settings → Bot members, for workspace admins: every bot member (EmployAI agent) with its role, what it is
 * for, whether it is still a member and when its token was last used. Admins add a bot (its token is shown once),
 * change it, give it a new token (shown once; the old one stops working) and remove it.
 */
export const BotMembersAdmin = observer(function BotMembersAdmin({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const { getBots, fetchBots, createBot, updateBot, rotateToken, removeBot } = useBotMember();
  const {
    workspace: { fetchWorkspaceMembers },
  } = useMember();
  // A bot is a workspace member: the members list and pickers show the change at once.
  const refreshMembers = () => void fetchWorkspaceMembers(workspaceSlug).catch(() => undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dialog, setDialog] = useState<TDialog | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const bots = getBots(workspaceSlug);

  const load = useCallback(() => {
    fetchBots(workspaceSlug)
      .then(() => setLoadFailed(false))
      .catch(() => setLoadFailed(true));
  }, [fetchBots, workspaceSlug]);

  useEffect(() => {
    if (workspaceSlug) load();
  }, [load, workspaceSlug]);

  // Active bots first, then by name.
  const sorted = useMemo(
    () =>
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy; the web app's TS lib (ES2022) has no toSorted
      [...(bots ?? [])].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)),
    [bots]
  );

  const handleCreate = async (data: TBotMemberCreate | TBotMemberUpdate) => {
    const created = await createBot(workspaceSlug, data as TBotMemberCreate);
    refreshMembers();
    setDialog({ kind: "show_token", botName: created.name, token: created.token });
  };

  const handleUpdate = async (bot: TBotMember, data: TBotMemberCreate | TBotMemberUpdate) => {
    await updateBot(workspaceSlug, bot.id, data);
    refreshMembers();
    setDialog(null);
  };

  const handleNewToken = async (bot: TBotMember) => {
    setIsSubmitting(true);
    try {
      const updated = await rotateToken(workspaceSlug, bot.id);
      setToast({ type: "success", title: t("bot_members.toasts.token_created") });
      setDialog({ kind: "show_token", botName: updated.name, token: updated.token });
    } catch (caught) {
      setToast({ type: "error", title: t("bot_members.toasts.token_failed"), message: codingErrorMessage(t, caught) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async (bot: TBotMember) => {
    setIsSubmitting(true);
    try {
      await removeBot(workspaceSlug, bot.id);
      refreshMembers();
      setToast({ type: "success", title: t("bot_members.toasts.removed") });
      setDialog(null);
    } catch (caught) {
      setToast({ type: "error", title: t("bot_members.toasts.remove_failed"), message: codingErrorMessage(t, caught) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const actionButton = (bot: TBotMember, kind: "edit" | "token" | "remove", label: string) => (
    <Button
      variant="secondary"
      size="sm"
      stretch="auto"
      label={label}
      aria-label={`${label}: ${bot.name}`}
      onClick={() => setDialog({ kind, bot })}
    />
  );

  const columns: DataTableColumn<TBotMember>[] = [
    {
      key: "name",
      content: t("bot_members.columns.name"),
      tdRender: (bot) => (
        <div className="flex max-w-80 min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-body-xs-medium text-primary">{bot.name}</span>
            <Badge size="xs" variant="purple" label={t("bot_members.badge")} />
          </span>
          <span className="truncate text-caption-sm-regular text-tertiary">{bot.display_name}</span>
          {bot.description && (
            <span className="line-clamp-2 text-caption-sm-regular break-words text-secondary" title={bot.description}>
              {bot.description}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "role",
      content: t("bot_members.columns.role"),
      tdRender: (bot) => {
        const key = botRoleKey(bot.role);
        return <span className="text-body-xs-regular text-primary">{key ? t(key) : "-"}</span>;
      },
    },
    {
      key: "status",
      content: t("bot_members.columns.status"),
      tdRender: (bot) => (
        <Badge
          size="xs"
          variant={bot.is_active ? "success" : "grey"}
          label={t(bot.is_active ? "bot_members.status.active" : "bot_members.status.removed")}
        />
      ),
    },
    {
      key: "token_last_used",
      content: t("bot_members.columns.token_last_used"),
      tdRender: (bot) => {
        if (!bot.token_created_at)
          return <span className="text-body-xs-regular text-tertiary">{t("bot_members.no_token")}</span>;
        if (!bot.token_last_used)
          return <span className="text-body-xs-regular text-tertiary">{t("bot_members.never_used")}</span>;
        return (
          <time
            className="text-body-xs-regular text-primary"
            dateTime={bot.token_last_used}
            title={renderFormattedDate(new Date(bot.token_last_used), "MMM d, yyyy h:mma")}
          >
            {calculateTimeAgo(bot.token_last_used)}
          </time>
        );
      },
    },
    {
      key: "actions",
      content: "",
      tdRender: (bot) =>
        bot.is_active ? (
          <div className="flex flex-wrap justify-end gap-2 px-2">
            {actionButton(bot, "edit", t("bot_members.actions.edit"))}
            {actionButton(bot, "token", t("bot_members.actions.new_token"))}
            {actionButton(bot, "remove", t("bot_members.actions.remove"))}
          </div>
        ) : null,
    },
  ];

  const tokenBot = dialog?.kind === "token" ? dialog.bot : null;
  const removingBot = dialog?.kind === "remove" ? dialog.bot : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="md"
          stretch="auto"
          label={t("bot_members.add")}
          onClick={() => setDialog({ kind: "create" })}
        />
      </div>
      {loadFailed && (
        <p role="alert" className="text-body-xs-regular text-danger-primary">
          {t("bot_members.load_failed")}
        </p>
      )}
      {bots && bots.length === 0 && (
        <p className="rounded-lg border border-subtle bg-surface-1 px-4 py-10 text-center text-body-sm-regular text-tertiary">
          {t("bot_members.empty")}
        </p>
      )}
      {sorted.length > 0 && <DataTable<TBotMember> columns={columns} data={sorted} keyExtractor={(bot) => bot.id} />}

      {dialog?.kind === "create" && <BotMemberFormDialog onSubmit={handleCreate} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <BotMemberFormDialog
          bot={dialog.bot}
          onSubmit={(data) => handleUpdate(dialog.bot, data)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "show_token" && (
        <BotTokenDialog botName={dialog.botName} token={dialog.token} onClose={() => setDialog(null)} />
      )}
      <ConfirmDialog
        isOpen={!!tokenBot}
        variant="primary"
        title={t("bot_members.new_token_dialog.title", { name: tokenBot?.name ?? "" })}
        content={t("bot_members.new_token_dialog.description")}
        isSubmitting={isSubmitting}
        primaryButtonText={{
          default: t("bot_members.new_token_dialog.confirm"),
          loading: t("bot_members.new_token_dialog.confirming"),
        }}
        secondaryButtonText={t("common.cancel")}
        handleClose={() => setDialog(null)}
        handleSubmit={() => (tokenBot ? handleNewToken(tokenBot) : Promise.resolve())}
      />
      <ConfirmDialog
        isOpen={!!removingBot}
        variant="danger"
        title={t("bot_members.remove_dialog.title", { name: removingBot?.name ?? "" })}
        content={t("bot_members.remove_dialog.description")}
        isSubmitting={isSubmitting}
        primaryButtonText={{
          default: t("bot_members.remove_dialog.confirm"),
          loading: t("bot_members.remove_dialog.confirming"),
        }}
        secondaryButtonText={t("common.cancel")}
        handleClose={() => setDialog(null)}
        handleSubmit={() => (removingBot ? handleRemove(removingBot) : Promise.resolve())}
      />
    </div>
  );
});
