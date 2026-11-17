/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useId } from "react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { CopyOutline } from "@makeplane/propel/icons";
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { copyTextToClipboard } from "@plane/utils";

type Props = {
  botName: string;
  token: string;
  onClose: () => void;
};

/**
 * A bot member's token, shown once after it is created or replaced: a copy button and a note that it won't be shown
 * again. Only "Done" closes it, so an outside click cannot throw the token away.
 */
export function BotTokenDialog({ botName, token, onClose }: Props) {
  const { t } = useTranslation();
  const fieldId = useId();

  const copy = () => {
    void copyTextToClipboard(token).then(() =>
      setToast({ type: "success", title: t("bot_members.token_dialog.copied") })
    );
  };

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="md">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("bot_members.token_dialog.title", { name: botName })}</DialogTitle>
              <DialogDescription>{t("bot_members.token_dialog.description")}</DialogDescription>
            </DialogHeading>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={fieldId} className="text-body-xs-medium text-secondary">
                {t("bot_members.token_dialog.label")}
              </label>
              <div className="flex items-center gap-2 rounded-md border border-subtle bg-layer-1 py-1.5 pr-1.5 pl-3">
                <input
                  id={fieldId}
                  data-testid="bot-token"
                  readOnly
                  value={token}
                  spellCheck={false}
                  autoComplete="off"
                  onFocus={(event) => event.currentTarget.select()}
                  className="font-mono min-w-0 flex-1 bg-transparent text-body-xs-regular text-primary outline-none"
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={CopyOutline} />}
                  aria-label={t("bot_members.token_dialog.copy")}
                  onClick={copy}
                />
              </div>
            </div>
          </DialogBody>
        </DialogMain>
        <DialogActions>
          <Button
            variant="primary"
            size="md"
            stretch="auto"
            label={t("bot_members.token_dialog.done")}
            onClick={onClose}
          />
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
