/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { InputField } from "@makeplane/propel/components/input-field";
import { SwitchField } from "@makeplane/propel/components/switch-field";
import { ConfirmDialog } from "@plane/blocks/dialog";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TInstanceChatSettings } from "@plane/types";
// local imports
import { DEFAULT_RETENTION_DAYS, deletesMore, parseRetentionDays } from "./helpers";

type Props = {
  settings: TInstanceChatSettings;
  onSave: (retentionDays: number) => Promise<void>;
};

/** Keep messages forever, or delete them after a number of days. */
export function MessageRetentionForm({ settings, onSave }: Props) {
  const { t } = useTranslation();
  const saved = settings.retention_days;
  const [enabled, setEnabled] = useState(saved > 0);
  const [daysInput, setDaysInput] = useState(String(saved || DEFAULT_RETENTION_DAYS));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const days = parseRetentionDays(daysInput, settings.min_retention_days, settings.max_retention_days);
  const next = enabled ? days : 0;
  const invalid = enabled && days === null;
  const changed = next !== null && next !== saved;

  const save = async () => {
    if (next === null) return;
    setSaving(true);
    try {
      await onSave(next);
      setToast({ type: "success", title: t("messages.admin.retention.saved") });
      setConfirming(false);
    } catch {
      setToast({ type: "error", title: t("messages.admin.retention.save_failed") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="message-retention-title">
      <div className="flex flex-col gap-1">
        <h3 id="message-retention-title" className="text-body-md-medium text-primary">
          {t("messages.admin.retention.title")}
        </h3>
        <p className="text-body-xs-regular text-secondary">{t("messages.admin.retention.description")}</p>
      </div>
      <SwitchField
        name="retention_enabled"
        size="lg"
        switchSize="md"
        label={t("messages.admin.retention.enable")}
        description={t("messages.admin.retention.enable_help")}
        checked={enabled}
        onCheckedChange={setEnabled}
      />
      {enabled && (
        <div className="max-w-60">
          <InputField
            id="message-retention-days"
            name="retention_days"
            size="lg"
            orientation="vertical"
            inputMode="numeric"
            label={t("messages.admin.retention.days")}
            description={t("messages.admin.retention.days_help", {
              min: settings.min_retention_days,
              max: settings.max_retention_days,
            })}
            value={daysInput}
            {...(invalid
              ? {
                  error: t("messages.admin.retention.days_invalid", {
                    min: settings.min_retention_days,
                    max: settings.max_retention_days,
                  }),
                }
              : {})}
            onChange={(event) => setDaysInput(event.target.value)}
          />
        </div>
      )}
      <div>
        <Button
          variant="primary"
          size="lg"
          stretch="auto"
          label={t("messages.admin.retention.save")}
          disabled={!changed || saving}
          loading={saving && !confirming}
          onClick={() => {
            if (next === null) return;
            if (deletesMore(saved, next)) setConfirming(true);
            else void save();
          }}
        />
      </div>
      <ConfirmDialog
        isOpen={confirming}
        title={t("messages.admin.retention.confirm_title")}
        content={t("messages.admin.retention.confirm_description", { days: next ?? 0 })}
        handleClose={() => {
          if (!saving) setConfirming(false);
        }}
        handleSubmit={save}
        isSubmitting={saving}
        primaryButtonText={{
          default: t("messages.admin.retention.confirm"),
          loading: t("messages.admin.retention.saving"),
        }}
        secondaryButtonText={t("messages.admin.cancel")}
      />
    </section>
  );
}
