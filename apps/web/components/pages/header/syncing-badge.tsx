/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState, useEffect } from "react";
import { CloudOffOutline, DotFilled } from "@makeplane/propel/icons";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { Badge } from "@makeplane/propel/components/badge";
import { Icon } from "@makeplane/propel/components/icon";

type Props = {
  syncStatus: "syncing" | "synced" | "error";
  // the live server reported a failed save and has not reported a successful one since
  hasSaveError?: boolean;
};

const BADGE_CONTENT = {
  syncing: {
    label: "Syncing...",
    tooltipLabel: "Syncing... Your changes are being synced with the server. You can continue making changes.",
  },
  error: {
    label: "Connection lost",
    tooltipLabel:
      "Connection lost. We're having trouble connecting to the websocket server. Your changes will be synced and saved every 10 seconds.",
  },
  not_saved: {
    label: "Not saved",
    tooltipLabel:
      "The server could not save your latest changes. Keep this page open: saving is tried again when you make another change.",
  },
};

export function PageSyncingBadge({ syncStatus, hasSaveError = false }: Props) {
  const status = hasSaveError ? "not_saved" : syncStatus;
  const [isVisible, setIsVisible] = useState(status !== "synced");

  // Runs once per status change. The pending hide is cancelled if the status moves on (or the badge
  // unmounts) before it fires, so a stale timer can't hide the badge during a later sync.
  useEffect(() => {
    if (status !== "synced") {
      setIsVisible(true);
      return;
    }
    // Delay hiding to allow exit animation to complete
    const timeoutId = setTimeout(() => {
      setIsVisible(false);
    }, 300); // match animation duration
    return () => clearTimeout(timeoutId);
  }, [status]);

  if (!isVisible || status === "synced") return null;

  // The synced early-return above guarantees this key exists
  const content = BADGE_CONTENT[status];

  return (
    <Tooltip label={content.tooltipLabel} layout="stacked">
      <span className="animate-quickFadeIn">
        <Badge
          variant={status === "syncing" ? "brand" : "danger"}
          size="sm"
          startIcon={<Icon icon={status === "syncing" ? DotFilled : CloudOffOutline} size="md" />}
          label={content.label}
        />
      </span>
    </Tooltip>
  );
}
