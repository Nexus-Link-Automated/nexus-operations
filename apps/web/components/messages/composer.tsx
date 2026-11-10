/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { observer } from "mobx-react";
import { useDropzone } from "react-dropzone";
// plane imports
import { IconButton } from "@makeplane/propel/components/icon-button";
import { AttachOutline, SendOutline } from "@makeplane/propel/icons";
import type { EditorRefApi } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
import { cn, isCommentEmpty } from "@plane/utils";
// components
import { LiteTextEditor } from "@/components/editor/lite-text";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useFileSize } from "@/hooks/use-file-size";
// store
import type { TChatOutgoingMessage } from "@/store/chat.store";
// local imports
import { ChatComposerAttachmentList, useChatComposerAttachments } from "./composer-attachments";

export type TChatComposerBody = TChatOutgoingMessage & { body_json: Record<string, unknown> };

type Props = {
  workspaceSlug: string;
  channelId: string;
  placeholder: string;
  onSend: (body: TChatComposerBody) => void;
};

/** Files go on the message as attachments, never inside the text, so the editor itself takes no uploads. */
const noUploads = async (): Promise<string> => {
  throw new Error("Files are attached to a message, not embedded in it");
};

/**
 * The message box: Plane's lite rich-text editor with @mentions. Enter sends, Shift+Enter adds a line. The editor
 * clears at once; the store shows the message as pending until the API has it, with a retry if it fails. Unsent
 * text is kept in the store per channel, so it is still there after switching away and back. Files upload as soon
 * as they are added, and sending waits for all of them.
 */
export const ChatComposer = observer(function ChatComposer({ workspaceSlug, channelId, placeholder, onSend }: Props) {
  const { t } = useTranslation();
  const { getWorkspaceBySlug } = useWorkspace();
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id ?? "";
  const { getDraft, setDraft } = useChat();
  const editorRef = useRef<EditorRefApi>(null);
  // Read once: the editor takes its initial value only when it mounts.
  const [draft] = useState(() => getDraft(channelId));
  const [isEmpty, setIsEmpty] = useState(!draft);
  const { maxFileSize } = useFileSize();
  const attachments = useChatComposerAttachments(channelId, maxFileSize);

  const send = () => {
    const document = editorRef.current?.getDocument();
    if (!document || attachments.uploading) return;
    if (isCommentEmpty(document.html) && !attachments.hasReady) return;
    const files = attachments.takeReady();
    onSend({
      body_html: document.html,
      body_json: (document.json ?? {}) as Record<string, unknown>,
      ...(files.length > 0 && { attachments: files }),
    });
    editorRef.current?.clearEditor();
    setIsEmpty(true);
    setDraft(channelId, "");
  };
  // The editor is built once and keeps the callback it was given, which needs the current state of the files.
  const latestSend = useRef(send);
  latestSend.current = send;
  const handleEnter = useCallback(() => latestSend.current(), []);

  const { getRootProps, getInputProps, open, isDragActive } = useDropzone({
    onDrop: attachments.addFiles,
    noClick: true,
    noKeyboard: true,
    multiple: true,
  });

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    // Pasting text that also carries an image (from a word processor, say) is pasting text.
    if (files.length > 0 && !event.clipboardData.getData("text/plain")) attachments.addFiles(files);
  };

  return (
    <div
      {...getRootProps({ onPaste: handlePaste })}
      className={cn("relative rounded-md border border-subtle bg-layer-1", isDragActive && "border-accent-strong")}
    >
      <input {...getInputProps()} aria-label={t("messages.attachments.attach")} />
      <ChatComposerAttachmentList
        drafts={attachments.drafts}
        limitError={attachments.limitError}
        onRemove={attachments.remove}
      />
      <div className="flex items-end gap-2 px-3 py-2">
        <IconButton
          variant="ghost"
          size="sm"
          icon={<AttachOutline />}
          aria-label={t("messages.attachments.attach")}
          onClick={open}
        />
        <div className="min-w-0 flex-1">
          <LiteTextEditor
            editable
            ref={editorRef}
            id={`chat-composer-${channelId}`}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            initialValue={draft ?? "<p></p>"}
            // Opening a conversation means typing in it.
            autofocus
            placeholder={placeholder}
            onChange={(_json, html) => {
              const empty = isCommentEmpty(html);
              setIsEmpty(empty);
              setDraft(channelId, empty ? "" : html);
            }}
            onEnterKeyPress={handleEnter}
            uploadFile={noUploads}
            duplicateFile={noUploads}
            disabledExtensions={["image"]}
            variant="none"
            parentClassName="w-full rounded-none border-0 p-0"
            containerClassName="max-h-48 min-h-6 overflow-y-auto overscroll-contain"
            displayConfig={{ fontSize: "small-font" }}
          />
        </div>
        <IconButton
          variant="primary"
          size="sm"
          icon={<SendOutline />}
          aria-label={t("messages.composer.send")}
          disabled={attachments.uploading || (isEmpty && !attachments.hasReady)}
          onClick={send}
        />
      </div>
    </div>
  );
});
