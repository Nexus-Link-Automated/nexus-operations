/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { InputField } from "@makeplane/propel/components/input-field";
import { SelectField } from "@makeplane/propel/components/select-field";
import { Switch } from "@makeplane/propel/components/switch";
import { setToast } from "@plane/blocks/toast";
import { Loader } from "@plane/blocks/skeleton";
import { useTranslation } from "@plane/i18n";
import type { TCodingColumn, TProjectCodingSettings, TProjectCodingSettingsUpdate } from "@plane/types";
// components
import { SettingsControlItem } from "@/components/settings/control-item";
// hooks
import { useCodingJob } from "@/hooks/store/use-coding-job";
import { useProjectState } from "@/hooks/store/use-project-state";
// local imports
import { codingErrorMessage, codingFieldErrors } from "./helpers";
import { CodingRepositoryStatus } from "./repository-status";
import { useCodingAccess } from "./use-coding-access";

type Props = {
  workspaceSlug: string;
  projectId: string;
};

const COLUMNS: { column: TCodingColumn; field: "ready_state" | "failed_state" | "in_review_state" }[] = [
  { column: "ready", field: "ready_state" },
  { column: "failed", field: "failed_state" },
  { column: "in_review", field: "in_review_state" },
];

/** The state name each column matches when none is chosen. The API matches these English names, so they are not translated. */
const MATCH_NAMES: Record<TCodingColumn, string> = { ready: "Ready", failed: "Failed", in_review: "In review" };

/** The picker's value for "no state chosen: match by name". */
const BY_NAME = "__by_name__";

/** What a new Failed column looks like: open work (a bug to fix), shown in red. */
const FAILED_STATE = { name: MATCH_NAMES.failed, group: "unstarted", color: "#DC2626" } as const;

type TForm = Required<TProjectCodingSettingsUpdate>;

const toForm = (settings: TProjectCodingSettings): TForm => ({
  enabled: settings.enabled,
  repo_url: settings.repo_url,
  default_branch: settings.default_branch,
  ready_state: settings.ready_state,
  failed_state: settings.failed_state,
  in_review_state: settings.in_review_state,
});

/**
 * A project's coding job settings: on or off, the repository and default branch, and which state each outcome
 * column (Ready, Failed, In review) means, and whether pull requests can be opened on the repository. Project admins
 * change them; members only read them.
 */
export const CodingJobsSettings = observer(function CodingJobsSettings({ workspaceSlug, projectId }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<TForm | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingFailed, setIsCreatingFailed] = useState(false);
  // store hooks
  const { getSettings, fetchSettings, updateSettings } = useCodingJob();
  const { getProjectStates, fetchProjectStates, createState } = useProjectState();
  const { canEditSettings: canEdit } = useCodingAccess(workspaceSlug, projectId);
  // derived values
  const settings = getSettings(projectId);
  const states = getProjectStates(projectId);
  const disabled = !canEdit || isSaving || isCreatingFailed;

  useEffect(() => {
    if (!workspaceSlug || !projectId) return;
    // The page passes `key={projectId}`, so this runs once per project; `active` drops a late answer after unmount.
    let active = true;
    setLoadError(null);
    const load = async () => {
      try {
        const loaded = await fetchSettings(workspaceSlug, projectId);
        if (active) setForm(toForm(loaded));
      } catch (error) {
        if (active) setLoadError(error ?? new Error("load failed"));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [workspaceSlug, projectId, fetchSettings]);

  useEffect(() => {
    if (workspaceSlug && projectId && !states) fetchProjectStates(workspaceSlug, projectId).catch(() => undefined);
  }, [workspaceSlug, projectId, states, fetchProjectStates]);

  const changes = useMemo(() => {
    if (!form || !settings) return {};
    const saved = toForm(settings);
    return Object.fromEntries(
      (Object.keys(form) as (keyof TForm)[]).filter((key) => form[key] !== saved[key]).map((key) => [key, form[key]])
    ) as TProjectCodingSettingsUpdate;
  }, [form, settings]);
  const isDirty = Object.keys(changes).length > 0;

  if (loadError) return <p className="text-body-sm-regular text-danger-primary">{codingErrorMessage(t, loadError)}</p>;
  if (!settings || !form) {
    return (
      <Loader className="flex flex-col gap-4">
        <Loader.Item height="48px" />
        <Loader.Item height="48px" />
        <Loader.Item height="48px" />
      </Loader>
    );
  }

  const set = <K extends keyof TForm>(key: K, value: TForm[K]) =>
    setForm((current) => current && { ...current, [key]: value });

  const handleSave = async () => {
    setFieldErrors({});
    setIsSaving(true);
    try {
      const saved = await updateSettings(workspaceSlug, projectId, changes);
      setForm(toForm(saved));
      setToast({ type: "success", title: t("coding_jobs.settings.saved") });
    } catch (error) {
      setFieldErrors(codingFieldErrors(error));
      setToast({ type: "error", title: t("coding_jobs.settings.save_failed"), message: codingErrorMessage(t, error) });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateFailed = async () => {
    setIsCreatingFailed(true);
    let created = false;
    try {
      const state = await createState(workspaceSlug, projectId, { ...FAILED_STATE });
      created = true;
      const saved = await updateSettings(workspaceSlug, projectId, { failed_state: state.id });
      // Keep any other unsaved edits; only the Failed column is now saved.
      setForm((current) => current && { ...current, failed_state: saved.failed_state });
      setToast({ type: "success", title: t("coding_jobs.settings.failed_created") });
    } catch (error) {
      // The state exists even if choosing it failed: reload, so it shows as matched by name and the button goes.
      if (created) fetchSettings(workspaceSlug, projectId).catch(() => undefined);
      setToast({
        type: "error",
        title: t("coding_jobs.settings.create_failed_error"),
        message: codingErrorMessage(t, error),
      });
    } finally {
      setIsCreatingFailed(false);
    }
  };

  const describeColumn = (column: TCodingColumn) => {
    const resolved = settings.columns[column];
    if (!resolved) return t("coding_jobs.settings.resolves_none");
    return t(resolved.chosen ? "coding_jobs.settings.resolves_to" : "coding_jobs.settings.resolves_to_by_name", {
      state: resolved.name,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {!canEdit && (
        <p className="rounded-md bg-layer-2 px-3 py-2 text-body-xs-regular text-secondary">
          {t("coding_jobs.settings.read_only")}
        </p>
      )}
      {!settings.configured && (
        <p className="rounded-md bg-layer-2 px-3 py-2 text-body-xs-regular text-secondary">
          {t("coding_jobs.settings.not_configured")}
        </p>
      )}

      <form
        id="coding-jobs-settings-form"
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canEdit && isDirty) void handleSave();
        }}
      >
        <SettingsControlItem
          title={t("coding_jobs.settings.enabled")}
          description={t("coding_jobs.settings.enabled_description")}
          control={
            <Switch
              size="md"
              checked={form.enabled}
              onCheckedChange={(checked) => set("enabled", checked)}
              disabled={disabled}
              aria-label={t("coding_jobs.settings.enabled")}
            />
          }
        />

        <InputField
          id="coding-repo-url"
          name="repo_url"
          type="url"
          size="lg"
          orientation="vertical"
          label={t("coding_jobs.settings.repo_url")}
          hint={t("coding_jobs.settings.repo_url_hint")}
          placeholder="https://github.com/org/repo"
          autoComplete="off"
          spellCheck={false}
          value={form.repo_url}
          disabled={disabled}
          {...(fieldErrors.repo_url ? { error: fieldErrors.repo_url } : {})}
          onChange={(event) => set("repo_url", event.target.value)}
        />

        <InputField
          id="coding-default-branch"
          name="default_branch"
          size="lg"
          orientation="vertical"
          label={t("coding_jobs.settings.default_branch")}
          autoComplete="off"
          spellCheck={false}
          value={form.default_branch}
          disabled={disabled}
          {...(fieldErrors.default_branch ? { error: fieldErrors.default_branch } : {})}
          onChange={(event) => set("default_branch", event.target.value)}
        />

        <CodingRepositoryStatus workspaceSlug={workspaceSlug} projectId={projectId} repoUrl={settings.repo_url} />

        <div className="flex flex-col gap-1">
          <h4 className="text-body-md-medium text-primary">{t("coding_jobs.settings.columns_title")}</h4>
          <p className="text-body-xs-regular text-tertiary">{t("coding_jobs.settings.columns_description")}</p>
        </div>

        {COLUMNS.map(({ column, field }) => {
          const columnName = t(`coding_jobs.settings.column.${column}`);
          // A chosen state that was deleted since counts as unset, as the API resolves it.
          const chosen = form[field];
          const pickerValue = chosen && (!states || states.some((state) => state.id === chosen)) ? chosen : BY_NAME;
          return (
            <div key={column} className="flex flex-col gap-1.5" data-testid={`coding-column-${column}`}>
              <SelectField<string>
                label={columnName}
                description={t(`coding_jobs.settings.column_hint.${column}`)}
                hint={describeColumn(column)}
                size="lg"
                width="auto"
                options={[
                  { value: BY_NAME, label: t("coding_jobs.settings.match_by_name", { name: MATCH_NAMES[column] }) },
                  ...(states ?? []).map((state) => ({ value: state.id, label: state.name })),
                ]}
                value={pickerValue}
                onValueChange={(value) => set(field, !value || value === BY_NAME ? null : value)}
                disabled={disabled}
                {...(fieldErrors[field] ? { error: fieldErrors[field] } : {})}
              />
              {column === "failed" && !settings.columns.failed && canEdit && (
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    stretch="auto"
                    label={t(
                      isCreatingFailed ? "coding_jobs.settings.creating_failed" : "coding_jobs.settings.create_failed"
                    )}
                    loading={isCreatingFailed}
                    disabled={isCreatingFailed || isSaving}
                    onClick={() => void handleCreateFailed()}
                  />
                </div>
              )}
            </div>
          );
        })}
      </form>

      {canEdit && (
        <div>
          <Button
            type="submit"
            form="coding-jobs-settings-form"
            variant="primary"
            size="md"
            stretch="auto"
            label={t(isSaving ? "coding_jobs.settings.saving" : "coding_jobs.settings.save")}
            loading={isSaving}
            disabled={!isDirty || isSaving || isCreatingFailed}
          />
        </div>
      )}
    </div>
  );
});
