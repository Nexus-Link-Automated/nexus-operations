/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Button } from "@makeplane/propel/components/button";
import { WarningCircleOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import type { TChatSocketClosedReason, TChatSocketStatus } from "@plane/services";

type Props = {
  status: TChatSocketStatus;
  closedReason: TChatSocketClosedReason | null;
  onReconnect: () => void;
};

/**
 * Says when live updates aren't arriving. Messages can still be sent (that is REST); what the user sees just isn't
 * updated live until the socket is back, and then it catches up on its own.
 */
export function ChatConnectionBanner({ status, closedReason, onReconnect }: Props) {
  const { t } = useTranslation();
  let message: string | undefined;
  if (status === "reconnecting") message = t("messages.connection.reconnecting");
  else if (status === "closed" && closedReason === "unauthenticated") message = t("messages.connection.signed_out");
  else if (status === "closed" && closedReason === "forbidden") message = t("messages.connection.forbidden");
  else if (status === "closed" && closedReason === "bad_request") message = t("messages.connection.failed");
  if (!message) return null;

  return (
    <output className="flex flex-shrink-0 items-center gap-2 border-b border-subtle bg-layer-2 px-4 py-2 text-body-xs-regular text-secondary">
      <WarningCircleOutline className="size-4 flex-shrink-0 text-warning-primary" />
      <span className="min-w-0 flex-1">{message}</span>
      {status === "reconnecting" && (
        <Button
          variant="ghost"
          size="sm"
          stretch="auto"
          label={t("messages.connection.reconnect")}
          onClick={onReconnect}
        />
      )}
    </output>
  );
}
