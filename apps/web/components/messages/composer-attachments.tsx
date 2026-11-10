/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
// plane imports
import { IconButton } from "@makeplane/propel/components/icon-button";
import { AttachOutline, CloseOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { ChatServiceError } from "@plane/services";
import type { TChatUploadedAttachment } from "@plane/types";
import { convertBytesToSize } from "@plane/utils";
// hooks
import { useChat } from "@/hooks/store/use-chat";
// store
import { CHAT_MAX_ATTACHMENTS } from "@/store/chat.store";

/** Types shown as a thumbnail while composing: the blob stays on the user's own machine, so this is display only. */
const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

export type TChatDraftAttachment = {
  key: string;
  name: string;
  size: number;
  previewUrl: string | null;
  status: "uploading" | "ready" | "failed";
  progress: number;
  /** Why it failed, already translated. */
  error?: string;
  uploaded?: TChatUploadedAttachment;
};

const revokePreview = (draft: TChatDraftAttachment) => {
  if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
};

/**
 * The files being attached in the composer. Each uploads as soon as it is added, so sending only has to name IDs;
 * until then the composer holds it back. Too-large and refused files stay in the list with their error until removed.
 */
export function useChatComposerAttachments(channelId: string, maxFileSize: number) {
  const { t } = useTranslation();
  const { uploadAttachment, deleteAttachment } = useChat();
  const [drafts, setDrafts] = useState<TChatDraftAttachment[]>([]);
  const [limitError, setLimitError] = useState<string | null>(null);
  const nextKey = useRef(0);
  const removedKeys = useRef(new Set<string>());
  const latestDrafts = useRef(drafts);
  latestDrafts.current = drafts;

  // Leaving the channel: the thumbnails go. An upload nobody sends is cleaned up on the server's schedule.
  useEffect(() => () => latestDrafts.current.forEach(revokePreview), []);

  const update = (key: string, changes: Partial<TChatDraftAttachment>) =>
    setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, ...changes } : draft)));

  const startUpload = (key: string, file: File) => {
    uploadAttachment(channelId, file, (progress) => update(key, { progress }))
      .then((uploaded) => {
        // Removed while it was still uploading.
        if (removedKeys.current.has(key)) deleteAttachment(channelId, uploaded.id);
        else update(key, { status: "ready", progress: 100, uploaded });
      })
      .catch((error: unknown) => {
        const refused = error instanceof ChatServiceError && error.status === 400;
        const limited = error instanceof ChatServiceError && error.isRateLimited;
        update(key, {
          status: "failed",
          error: refused
            ? t("messages.attachments.not_allowed", { name: file.name })
            : limited
              ? t("messages.attachments.rate_limited", { name: file.name })
              : t("messages.attachments.failed", { name: file.name }),
        });
      });
  };

  const addFiles = (files: File[]) => {
    const inUse = latestDrafts.current.filter((draft) => draft.status !== "failed").length;
    const accepted = files.slice(0, Math.max(0, CHAT_MAX_ATTACHMENTS - inUse));
    setLimitError(
      accepted.length < files.length ? t("messages.attachments.too_many", { count: CHAT_MAX_ATTACHMENTS }) : null
    );

    const added = accepted.map((file) => {
      nextKey.current += 1;
      const tooLarge = file.size > maxFileSize;
      const draft: TChatDraftAttachment = {
        key: `draft-${nextKey.current}`,
        name: file.name,
        size: file.size,
        previewUrl: !tooLarge && THUMBNAIL_TYPES.has(file.type) ? URL.createObjectURL(file) : null,
        status: tooLarge ? "failed" : "uploading",
        progress: 0,
        ...(tooLarge && {
          error: t("messages.attachments.too_large", { name: file.name, limit: maxFileSize / 1024 / 1024 }),
        }),
      };
      return { draft, file };
    });
    if (added.length === 0) return;
    setDrafts((list) => [...list, ...added.map(({ draft }) => draft)]);
    for (const { draft, file } of added) if (draft.status === "uploading") startUpload(draft.key, file);
  };

  const remove = (key: string) => {
    const draft = latestDrafts.current.find((item) => item.key === key);
    if (!draft) return;
    removedKeys.current.add(key);
    revokePreview(draft);
    if (draft.uploaded) deleteAttachment(channelId, draft.uploaded.id);
    setDrafts((list) => list.filter((item) => item.key !== key));
    setLimitError(null);
  };

  /** Hand over the finished files for sending. Failed ones stay listed, so they don't vanish unnoticed. */
  const takeReady = (): TChatUploadedAttachment[] => {
    const ready = latestDrafts.current.filter((draft) => draft.status === "ready" && draft.uploaded);
    ready.forEach(revokePreview);
    const keys = new Set(ready.map((draft) => draft.key));
    setDrafts((list) => list.filter((draft) => !keys.has(draft.key)));
    setLimitError(null);
    return ready.map((draft) => draft.uploaded!);
  };

  return {
    drafts,
    limitError,
    hasReady: drafts.some((draft) => draft.status === "ready"),
    uploading: drafts.some((draft) => draft.status === "uploading"),
    addFiles,
    remove,
    takeReady,
  };
}

type ListProps = {
  drafts: TChatDraftAttachment[];
  limitError: string | null;
  onRemove: (key: string) => void;
};

/** What's attached so far, above the message box. */
export function ChatComposerAttachmentList({ drafts, limitError, onRemove }: ListProps) {
  const { t } = useTranslation();
  if (drafts.length === 0 && !limitError) return null;
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-2">
      {drafts.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {drafts.map((draft) => (
            <li
              key={draft.key}
              className="flex max-w-60 min-w-40 flex-col gap-1 rounded-md border border-subtle bg-layer-2 px-2 py-1.5"
            >
              <div className="flex items-center gap-2">
                {draft.previewUrl ? (
                  <img src={draft.previewUrl} alt="" className="size-6 flex-shrink-0 rounded-sm object-cover" />
                ) : (
                  <AttachOutline className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-body-xs-regular text-primary">{draft.name}</span>
                <span className="flex-shrink-0 text-caption-sm-regular text-tertiary">
                  {convertBytesToSize(draft.size)}
                </span>
                <IconButton
                  variant="ghost"
                  size="sm"
                  icon={<CloseOutline />}
                  aria-label={t("messages.attachments.remove", { name: draft.name })}
                  onClick={() => onRemove(draft.key)}
                />
              </div>
              {draft.status === "uploading" && (
                <div
                  role="progressbar"
                  aria-label={t("messages.attachments.uploading", { name: draft.name })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={draft.progress}
                  className="h-1 overflow-hidden rounded-full bg-layer-3"
                >
                  <div className="h-full bg-accent-primary" style={{ width: `${draft.progress}%` }} />
                </div>
              )}
              {draft.error && (
                <p role="alert" className="text-caption-sm-regular text-danger-primary">
                  {draft.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {limitError && (
        <p role="alert" className="text-caption-sm-regular text-danger-primary">
          {limitError}
        </p>
      )}
    </div>
  );
}
