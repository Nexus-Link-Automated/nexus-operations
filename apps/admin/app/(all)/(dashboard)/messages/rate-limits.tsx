/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { useTranslation } from "@plane/i18n";
import type { TInstanceChatRateLimitName, TInstanceChatSettings } from "@plane/types";
// local imports
import { parseRate } from "./helpers";

const LIMITS: TInstanceChatRateLimitName[] = ["send", "edit", "upload", "channel", "search", "read", "work_item"];
/** The limits on agents answering @mentions. */
const AGENT_LIMITS: TInstanceChatRateLimitName[] = ["agent_session", "agent_channel", "agent_post", "agent_dm_turn"];

type Props = {
  limits: TInstanceChatSettings["rate_limits"];
  /** How long an agent may work on a mention. */
  agentReplyTimeoutSeconds?: number;
};

/** The limits, read only: they are set on the API with environment variables. */
export function MessageRateLimits({ limits, agentReplyTimeoutSeconds }: Props) {
  const { t } = useTranslation();
  const describe = (rate: string) => {
    const parsed = parseRate(rate);
    return parsed ? t(`messages.admin.rate_limits.per_${parsed.period}`, { count: parsed.count }) : rate;
  };
  const rows = (names: TInstanceChatRateLimitName[]) =>
    names
      .filter((name) => limits[name]?.length)
      .map((name) => (
        <div key={name} className="contents">
          <dt className="text-body-xs-regular text-secondary">{t(`messages.admin.rate_limits.names.${name}`)}</dt>
          <dd className="text-body-xs-medium text-primary">{limits[name]!.map(describe).join(", ")}</dd>
        </div>
      ));
  const agentRows = rows(AGENT_LIMITS);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="message-rate-limits-title">
      <div className="flex flex-col gap-1">
        <h3 id="message-rate-limits-title" className="text-body-md-medium text-primary">
          {t("messages.admin.rate_limits.title")}
        </h3>
        <p className="text-body-xs-regular text-secondary">{t("messages.admin.rate_limits.description")}</p>
      </div>
      <dl className="grid max-w-xl grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[1fr_auto]">{rows(LIMITS)}</dl>
      {(agentRows.length > 0 || agentReplyTimeoutSeconds !== undefined) && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <h4 className="text-body-sm-medium text-primary">{t("messages.admin.rate_limits.agents_title")}</h4>
            <p className="text-body-xs-regular text-secondary">{t("messages.admin.rate_limits.agents_description")}</p>
          </div>
          <dl className="grid max-w-xl grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[1fr_auto]">
            {agentRows}
            {agentReplyTimeoutSeconds !== undefined && (
              <div className="contents">
                <dt className="text-body-xs-regular text-secondary">{t("messages.admin.rate_limits.agent_timeout")}</dt>
                <dd className="text-body-xs-medium text-primary">
                  {t("messages.admin.rate_limits.seconds", { count: agentReplyTimeoutSeconds })}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}
