/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { useTranslation } from "@plane/i18n";
import type { TCodingRepositoryAccess } from "@plane/types";
// hooks
import { useCodingJob } from "@/hooks/store/use-coding-job";

type Props = {
  workspaceSlug: string;
  projectId: string;
  /** Changes when the saved repository changes, so the status is checked again. */
  repoUrl: string;
};

/** Only links the API itself gave as https are made clickable. */
const isHttpsUrl = (value: string | null | undefined): value is string => {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const readyKey = (repository: TCodingRepositoryAccess) => {
  if (repository.private === true) return "coding_jobs.repository.ready_private";
  if (repository.private === false) return "coding_jobs.repository.ready_public";
  return "coding_jobs.repository.ready";
};

/**
 * Whether the CRM can open pull requests on the project's repository, with what to do when it can't (such as
 * installing the GitHub App). The API asks GitHub for this, so it loads on its own and never holds up the settings
 * form; a failure only shows here.
 */
export const CodingRepositoryStatus = observer(function CodingRepositoryStatus({
  workspaceSlug,
  projectId,
  repoUrl,
}: Props) {
  const { t } = useTranslation();
  const { getRepository, fetchRepository } = useCodingJob();
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const repository = getRepository(projectId);

  // `isCurrent` drops an answer that arrives after unmount or after the repository changed.
  const check = useCallback(
    (isCurrent: () => boolean = () => true) => {
      setState("loading");
      fetchRepository(workspaceSlug, projectId, repoUrl)
        .then(() => isCurrent() && setState("loaded"))
        .catch(() => isCurrent() && setState("failed"));
    },
    [fetchRepository, workspaceSlug, projectId, repoUrl]
  );

  useEffect(() => {
    if (!workspaceSlug || !projectId) return;
    let current = true;
    check(() => current);
    return () => {
      current = false;
    };
  }, [check, workspaceSlug, projectId]);

  const installUrl =
    repository && repository.installed !== true && !repository.pull_requests && isHttpsUrl(repository.install_url)
      ? repository.install_url
      : null;

  return (
    <section
      data-testid="coding-repository-status"
      aria-label={t("coding_jobs.repository.title")}
      aria-busy={state === "loading"}
      className="flex flex-col gap-2 rounded-md border border-subtle px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-body-sm-medium text-primary">{t("coding_jobs.repository.title")}</h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          stretch="auto"
          label={t("coding_jobs.repository.check_again")}
          disabled={state === "loading"}
          onClick={() => check()}
        />
      </div>
      {state === "loading" && (
        <p className="text-body-xs-regular text-tertiary" aria-live="polite">
          {t("coding_jobs.repository.checking")}
        </p>
      )}
      {state === "failed" && (
        <p role="alert" className="text-body-xs-regular text-danger-primary">
          {t("coding_jobs.repository.check_failed")}
        </p>
      )}
      {state === "loaded" && repository && (
        <>
          <p className="text-body-xs-regular break-words text-secondary">
            {repository.pull_requests ? t(readyKey(repository)) : repository.reason || t("coding_jobs.repository.off")}
          </p>
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-fit text-body-xs-medium text-accent-primary hover:underline"
            >
              {t("coding_jobs.repository.install")}
            </a>
          )}
        </>
      )}
    </section>
  );
});
