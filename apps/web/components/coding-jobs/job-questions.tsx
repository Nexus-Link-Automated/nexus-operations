/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useId, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { TextAreaField } from "@makeplane/propel/components/text-area-field";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import type { TCodingJob, TCodingJobQuestion } from "@plane/types";
import { calculateTimeAgo, renderFormattedDate } from "@plane/utils";
// hooks
import { useCodingJob } from "@/hooks/store/use-coding-job";
// local imports
import { codingErrorMessage } from "./helpers";

/** The API's limit for one answer. */
export const MAX_ANSWER_LENGTH = 4000;

const DATE_FORMAT = "MMM d, yyyy h:mma";

/** The question the agent waits on: the job needs input and its newest question is not settled yet. */
export const openQuestion = (job: Pick<TCodingJob, "status" | "questions">): TCodingJobQuestion | undefined => {
  if (job.status !== "needs_input") return undefined;
  const last = job.questions?.[job.questions.length - 1];
  return last && (last.status === "waiting" || last.status === "thinking") ? last : undefined;
};

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  job: TCodingJob;
  /** A project member or admin: may answer the open question. */
  canAnswer: boolean;
};

/**
 * A job's questions from the coding agent, oldest first, with who answered each one. While the job waits on one, it
 * is shown on top with a box to answer it (for members and admins). Questions and answers are written by agents and
 * people, so they are rendered as plain text only.
 */
export const CodingJobQuestions = observer(function CodingJobQuestions({
  workspaceSlug,
  projectId,
  issueId,
  job,
  canAnswer,
}: Props) {
  const { t } = useTranslation();
  const fieldId = useId();
  const { answerJob } = useCodingJob();
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const questions = job.questions ?? [];
  const open = openQuestion(job);
  const settled = questions.filter((question) => question !== open);

  if (questions.length === 0) return null;

  const handleAnswer = async () => {
    const answer = text.trim();
    if (!answer || !open) return;
    setIsSubmitting(true);
    try {
      await answerJob(workspaceSlug, projectId, issueId, job.id, answer);
      setText("");
      setToast({ type: "success", title: t("coding_jobs.toasts.answered") });
    } catch (error) {
      setToast({ type: "error", title: t("coding_jobs.toasts.answer_failed"), message: codingErrorMessage(t, error) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const answeredBy = (question: TCodingJobQuestion) => {
    if (question.answered_by_agent) return t("coding_jobs.panel.answered_by_agent");
    if (question.answered_by_name) return t("coding_jobs.panel.answered_by", { name: question.answered_by_name });
    return t("coding_jobs.panel.answered_by_unknown");
  };

  return (
    <div className="flex flex-col gap-2">
      {open && (
        <div
          data-testid="coding-job-open-question"
          className="flex flex-col gap-2 rounded-md border border-warning-subtle bg-warning-subtle px-3 py-2"
        >
          <span className="text-caption-sm-medium text-primary">{t("coding_jobs.panel.open_question")}</span>
          <p className="text-body-xs-regular break-words whitespace-pre-wrap text-primary">{open.question}</p>
          <span className="text-caption-sm-regular text-tertiary">
            {t(
              open.status === "thinking" ? "coding_jobs.panel.question_thinking" : "coding_jobs.panel.question_waiting"
            )}
          </span>
          {canAnswer && (
            <form
              className="flex flex-col gap-2"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void handleAnswer();
              }}
            >
              <TextAreaField
                id={fieldId}
                name="answer"
                size="lg"
                resize="none"
                autoResize
                maxRows={8}
                label={t("coding_jobs.panel.answer_label")}
                placeholder={t("coding_jobs.panel.answer_placeholder")}
                hint={t("coding_jobs.panel.answer_hint")}
                maxLength={MAX_ANSWER_LENGTH}
                value={text}
                disabled={isSubmitting}
                onChange={(event) => setText(event.target.value)}
              />
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  stretch="auto"
                  label={t(isSubmitting ? "coding_jobs.panel.answering" : "coding_jobs.panel.answer")}
                  loading={isSubmitting}
                  disabled={!text.trim() || isSubmitting}
                />
              </div>
            </form>
          )}
        </div>
      )}
      {settled.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-caption-sm-medium text-secondary">{t("coding_jobs.panel.questions")}</span>
          <ol className="flex flex-col gap-1.5 rounded-sm bg-layer-1 px-2 py-1.5">
            {settled.map((question) => (
              <li key={question.seq} data-testid="coding-job-question" className="flex flex-col gap-0.5">
                <p
                  className="text-caption-sm-medium break-words whitespace-pre-wrap text-primary"
                  title={renderFormattedDate(new Date(question.asked_at), DATE_FORMAT)}
                >
                  {question.question}
                </p>
                {question.status === "answered" && (
                  <>
                    <p className="text-caption-sm-regular break-words whitespace-pre-wrap text-secondary">
                      {question.answer}
                    </p>
                    <span className="text-caption-sm-regular text-tertiary">
                      {answeredBy(question)}
                      {question.answered_at && (
                        <>
                          {" · "}
                          <time dateTime={question.answered_at}>{calculateTimeAgo(question.answered_at)}</time>
                        </>
                      )}
                    </span>
                  </>
                )}
                {question.status !== "answered" && (
                  // A question still open on a job that has ended will not be answered any more.
                  <span className="text-caption-sm-regular text-tertiary">
                    {t(
                      question.status !== "unanswered" && job.is_active
                        ? "coding_jobs.panel.question_waiting"
                        : "coding_jobs.panel.no_answer"
                    )}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
});
