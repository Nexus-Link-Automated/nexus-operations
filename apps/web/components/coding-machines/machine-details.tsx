/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { useTranslation } from "@plane/i18n";
import type { TCodingMachine } from "@plane/types";
import { calculateTimeAgo, cn, renderFormattedDate } from "@plane/utils";

const DATE_FORMAT = "MMM d, yyyy h:mma";

/** A dot and "Online", or "Offline" with when the machine was last seen (unless `hideLastSeen`). */
export function MachineOnlineStatus({ machine, hideLastSeen }: { machine: TCodingMachine; hideLastSeen?: boolean }) {
  const { t } = useTranslation();
  const online = machine.is_online;
  return (
    <span className="flex items-center gap-1.5 text-caption-md-regular text-tertiary">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", online ? "bg-success-primary" : "bg-layer-3")} />
      <span className={online ? "text-success-primary" : undefined}>
        {t(online ? "coding_machines.online" : "coding_machines.offline")}
      </span>
      {!online && !hideLastSeen && (
        <span>
          {" · "}
          {machine.last_seen_at ? (
            <time
              dateTime={machine.last_seen_at}
              title={renderFormattedDate(new Date(machine.last_seen_at), DATE_FORMAT)}
            >
              {t("coding_machines.last_seen", { time: calculateTimeAgo(machine.last_seen_at) })}
            </time>
          ) : (
            t("coding_machines.never_seen")
          )}
        </span>
      )}
    </span>
  );
}

const row = (label: string, value: React.ReactNode) => (
  <div className="flex gap-2">
    <dt className="w-24 shrink-0 text-tertiary">{label}</dt>
    <dd className="min-w-0 break-words text-secondary">{value}</dd>
  </div>
);

/** What the machine last reported: host, agents, Docker and free slots. */
export function MachineReport({ machine }: { machine: TCodingMachine }) {
  const { t } = useTranslation();
  const { agents, docker, slots } = machine.capabilities ?? {};
  const host = [machine.hostname, machine.os, machine.version && `v${machine.version}`].filter(Boolean).join(" · ");
  if (!host && !agents && !docker && !slots) return null;

  return (
    <dl className="flex flex-col gap-1 text-caption-md-regular">
      {host && row(t("coding_machines.host"), host)}
      {agents &&
        row(
          t("coding_machines.agents"),
          agents.length === 0
            ? t("coding_machines.no_agents")
            : agents
                .map((agent) => {
                  const name = [t(`coding_jobs.agents.${agent.id}`), agent.version].filter(Boolean).join(" ");
                  const status = !agent.installed
                    ? t("coding_machines.agent_not_installed")
                    : agent.signed_in
                      ? t("coding_machines.agent_signed_in")
                      : t("coding_machines.agent_not_signed_in");
                  return `${name}: ${status}`;
                })
                .join(" · ")
        )}
      {docker &&
        row(
          t("coding_machines.docker"),
          docker.available
            ? [t("coding_machines.docker_available"), docker.version].filter(Boolean).join(" ")
            : t("coding_machines.docker_unavailable")
        )}
      {slots &&
        row(t("coding_machines.slots"), t("coding_machines.slots_value", { free: slots.free, total: slots.total }))}
    </dl>
  );
}
