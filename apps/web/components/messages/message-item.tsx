/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { DeleteOutline, EditOutline } from "@makeplane/propel/icons";
import { ConfirmDialog } from "@plane/blocks/dialog";
import { setToast } from "@plane/blocks/toast";
import type { EditorRefApi } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
import type { TChatMessage } from "@plane/types";
import { cn, isCommentEmpty, renderFormattedTime } from "@plane/utils";
// components
import { LiteTextEditor } from "@/components/editor/lite-text";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useMember } from "@/hooks/store/use-member";
import { useWorkspace } from "@/hooks/store/use-workspace";
// store
import type { TChatPendingMessage } from "@/store/chat.store";
// local imports
import { MemberAvatar } from "./member-avatar";

const noUploads = async (): Promise<string> => {
  throw new Error("Attachments are not supported in messages yet");
};

type BodyProps = { id: string; html: string; workspaceSlug: string };

/** A message body, read-only. Keyed by the caller on the content, so an edit re-renders it. */
const MessageBody = observer(function MessageBody({ id, html, workspaceSlug }: BodyProps) {
  const { getWorkspaceBySlug } = useWorkspace();
  return (
    <LiteTextEditor
      editable={false}
      id={id}
      initialValue={html}
      workspaceId={getWorkspaceBySlug(workspaceSlug)?.id ?? ""}
      workspaceSlug={workspaceSlug}
      containerClassName="p-0!"
      parentClassName="border-none"
      displayConfig={{ fontSize: "small-font" }}
    />
  );
});

type Props = {
  message: TChatMessage;
  workspaceSlug: string;
  /** Opened from a link to this message. */
  highlighted?: boolean;
  /** Follows the same sender's previous message: no avatar or name. */
  continued: boolean;
};

export const ChatMessageItem = observer(function ChatMessageItem({
  message,
  workspaceSlug,
  continued,
  highlighted,
}: Props) {
  const { t } = useTranslation();
  const { userId, channelMap, editMessage, removeMessage } = useChat();
  const { getUserDetails } = useMember();
  const { getWorkspaceBySlug } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<EditorRefApi>(null);
  const saving = useRef(false);

  const channel = channelMap[message.channel];
  // The API refuses both once the user has left or the channel is archived.
  const canChange = !!channel?.is_member && !channel.archived_at;
  const mine = !!message.sender && message.sender === userId;
  const removed = !!message.removed_at;
  const name = (message.sender && getUserDetails(message.sender)?.display_name) || t("messages.unknown_member");
  const time = renderFormattedTime(message.created_at, "12-hour");

  const save = async () => {
    const document = editorRef.current?.getDocument();
    if (!document || isCommentEmpty(document.html) || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await editMessage(message.channel, message.id, {
        body_html: document.html,
        body_json: (document.json ?? {}) as Record<string, unknown>,
      });
      setEditing(false);
    } catch {
      setToast({ type: "error", title: t("messages.errors.edit_failed") });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeMessage(message.channel, message.id);
      setConfirmingRemove(false);
    } catch {
      setToast({ type: "error", title: t("messages.errors.remove_failed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-message-id={message.id}
      aria-label={t("messages.message.label", { name, time })}
      className={cn(
        "group relative flex gap-3 px-4 transition-colors hover:bg-layer-transparent-hover",
        continued ? "py-0.5" : "pt-2 pb-0.5",
        highlighted && "bg-accent-subtle"
      )}
    >
      <div className="flex w-8 flex-shrink-0 justify-center">
        {continued ? (
          <time
            dateTime={message.created_at}
            className="hidden pt-0.5 text-caption-sm-regular text-tertiary group-hover:inline"
          >
            {time}
          </time>
        ) : (
          <MemberAvatar userId={message.sender} size="md" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <span className="text-body-sm-semibold text-primary">{name}</span>
            <time dateTime={message.created_at} className="text-caption-sm-regular text-tertiary">
              {time}
            </time>
          </div>
        )}
        {removed ? (
          <p className="text-body-sm-regular text-tertiary italic">{t("messages.message.removed")}</p>
        ) : editing ? (
          <div
            role="group"
            aria-label={t("messages.message.edit")}
            className="mt-1 flex flex-col gap-2 rounded-md border border-subtle bg-layer-1 p-2"
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
          >
            <LiteTextEditor
              editable
              ref={editorRef}
              id={`chat-edit-${message.id}`}
              workspaceSlug={workspaceSlug}
              workspaceId={getWorkspaceBySlug(workspaceSlug)?.id ?? ""}
              initialValue={message.body_html}
              // Ready to type at the end of the message, as soon as Edit is clicked.
              handleEditorReady={(ready) => {
                if (ready) editorRef.current?.focus("end");
              }}
              onEnterKeyPress={() => void save()}
              uploadFile={noUploads}
              duplicateFile={noUploads}
              disabledExtensions={["image"]}
              variant="none"
              parentClassName="w-full rounded-none border-0 p-0"
              displayConfig={{ fontSize: "small-font" }}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                stretch="auto"
                label={t("common.cancel")}
                disabled={busy}
                onClick={() => setEditing(false)}
              />
              <Button
                variant="primary"
                size="sm"
                stretch="auto"
                label={t("messages.message.save")}
                loading={busy}
                onClick={() => void save()}
              />
            </div>
          </div>
        ) : (
          <MessageBody
            key={`${message.id}-${message.updated_at}`}
            id={`chat-message-${message.id}`}
            html={message.body_html}
            workspaceSlug={workspaceSlug}
          />
        )}
        {!removed && !editing && message.edited_at && (
          <span className="text-caption-sm-regular text-tertiary">{t("messages.message.edited")}</span>
        )}
        {message.reply_count > 0 && (
          <p className="text-caption-md-medium text-accent-primary">
            {t("messages.message.replies", { count: message.reply_count })}
          </p>
        )}
      </div>
      {mine && canChange && !removed && !editing && (
        <div className="absolute top-1 right-4 hidden items-center gap-0.5 rounded-md border border-subtle bg-layer-1 p-0.5 shadow-raised-100 group-focus-within:flex group-hover:flex">
          <IconButton
            variant="ghost"
            size="sm"
            icon={<EditOutline />}
            aria-label={t("messages.message.edit")}
            onClick={() => setEditing(true)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            icon={<DeleteOutline />}
            aria-label={t("messages.message.remove")}
            onClick={() => setConfirmingRemove(true)}
          />
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmingRemove}
        title={t("messages.message.remove_title")}
        content={t("messages.message.remove_description")}
        handleClose={() => setConfirmingRemove(false)}
        handleSubmit={remove}
        isSubmitting={busy}
        primaryButtonText={{ default: t("messages.message.remove"), loading: t("messages.message.removing") }}
      />
    </article>
  );
});

type PendingProps = {
  pending: TChatPendingMessage;
  workspaceSlug: string;
};

/** A message the API doesn't have yet: faded while sending, with retry and discard if it failed. */
export const ChatPendingMessageItem = observer(function ChatPendingMessageItem({
  pending,
  workspaceSlug,
}: PendingProps) {
  const { t } = useTranslation();
  const { userId, retryMessage, discardMessage } = useChat();
  const failed = pending.status === "failed";

  return (
    <article
      aria-label={failed ? t("messages.message.failed") : t("messages.message.sending")}
      className="flex gap-3 px-4 py-0.5"
    >
      <div className="flex w-8 flex-shrink-0 justify-center">
        <MemberAvatar userId={userId} size="md" />
      </div>
      <div className={cn("min-w-0 flex-1", { "opacity-60": !failed })}>
        <MessageBody id={`chat-pending-${pending.localId}`} html={pending.body_html} workspaceSlug={workspaceSlug} />
        {failed ? (
          <div className="flex items-center gap-2 text-caption-md-regular text-danger-primary">
            <span>{t("messages.message.failed")}</span>
            <Button
              variant="ghost"
              size="sm"
              stretch="auto"
              label={t("messages.message.retry")}
              onClick={() => void retryMessage(pending.channelId, pending.localId).catch(() => undefined)}
            />
            <Button
              variant="ghost"
              size="sm"
              stretch="auto"
              label={t("messages.message.discard")}
              onClick={() => discardMessage(pending.channelId, pending.localId)}
            />
          </div>
        ) : (
          <span className="text-caption-sm-regular text-tertiary">{t("messages.message.sending")}</span>
        )}
      </div>
    </article>
  );
});
