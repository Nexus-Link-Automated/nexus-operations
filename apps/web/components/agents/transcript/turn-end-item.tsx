/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo } from "react";
import type { TurnEndItem as TTurnEndItem } from "@plane/acp-client";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";

type Props = { item: TTurnEndItem };

/** How a turn ended when it did not end normally. */
export const TurnEndItem = memo(function TurnEndItem({ item }: Props) {
  const { t } = useTranslation();
  const isProblem = item.stopReason === "failed" || item.stopReason === "disconnected" || item.stopReason === "refusal";
  return (
    <p className={cn("text-caption-md-regular", isProblem ? "text-danger-primary" : "text-tertiary")}>
      {t(`agents.transcript.turn_end.${item.stopReason}`)}
    </p>
  );
});
