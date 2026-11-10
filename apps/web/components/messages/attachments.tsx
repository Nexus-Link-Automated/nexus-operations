/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
// plane imports
import { AttachOutline, DownloadOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import type { TChatAttachment, TChatMessage, TChatUploadedAttachment } from "@plane/types";
import { convertBytesToSize, getFileURL } from "@plane/utils";

/** A file, as a row that downloads it. */
function FileRow({ attachment }: { attachment: TChatAttachment }) {
  const { t } = useTranslation();
  return (
    <a
      href={getFileURL(attachment.download_url)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("messages.attachments.download", { name: attachment.name })}
      className="flex max-w-xs items-center gap-2 rounded-md border border-subtle bg-layer-2 px-2.5 py-1.5 transition-colors hover:bg-layer-2-hover"
    >
      <AttachOutline className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-body-xs-regular text-primary">{attachment.name}</span>
      <span className="flex-shrink-0 text-caption-sm-regular text-tertiary">{convertBytesToSize(attachment.size)}</span>
      <DownloadOutline className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
    </a>
  );
}

/** A raster image the API serves inline. If it won't load (access lost since it was rendered), the file row instead. */
function ImagePreview({ attachment }: { attachment: TChatAttachment }) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  if (broken) return <FileRow attachment={attachment} />;
  return (
    <div className="group/attachment relative w-fit">
      <a href={getFileURL(attachment.preview_url ?? "")} target="_blank" rel="noopener noreferrer">
        <img
          src={getFileURL(attachment.preview_url ?? "")}
          alt={attachment.name}
          loading="lazy"
          className="max-h-64 max-w-xs rounded-md border border-subtle object-contain"
          onError={() => setBroken(true)}
        />
      </a>
      <a
        href={getFileURL(attachment.download_url)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("messages.attachments.download", { name: attachment.name })}
        className="absolute top-1 right-1 hidden rounded-sm bg-layer-1 p-1 text-secondary shadow-raised-100 group-hover/attachment:flex"
      >
        <DownloadOutline className="size-3.5" aria-hidden />
      </a>
    </div>
  );
}

/** The files on a message. Someone reading a channel they aren't in sees how many there are, and no file. */
export function ChatMessageAttachments({ message }: { message: TChatMessage }) {
  const { t } = useTranslation();
  const { attachments, attachment_count: count } = message;
  if (attachments.length === 0) {
    if (count === 0) return null;
    return <p className="mt-1 text-caption-md-regular text-tertiary">{t("messages.attachments.hidden", { count })}</p>;
  }
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {attachments.map((attachment) =>
        attachment.preview_url ? (
          <ImagePreview key={attachment.id} attachment={attachment} />
        ) : (
          <FileRow key={attachment.id} attachment={attachment} />
        )
      )}
    </div>
  );
}

/** Files on a message still being sent: named, not yet openable. */
export function ChatPendingAttachments({ attachments }: { attachments: TChatUploadedAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex max-w-xs items-center gap-2 rounded-md border border-subtle px-2.5 py-1.5"
        >
          <AttachOutline className="size-3.5 flex-shrink-0 text-tertiary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-body-xs-regular text-secondary">{attachment.name}</span>
          <span className="flex-shrink-0 text-caption-sm-regular text-tertiary">
            {convertBytesToSize(attachment.size)}
          </span>
        </div>
      ))}
    </div>
  );
}
