/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { IconButton } from "@makeplane/propel/components/icon-button";
import { SendOutline } from "@makeplane/propel/icons";
import type { EditorRefApi } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
import { isCommentEmpty } from "@plane/utils";
// components
import { LiteTextEditor } from "@/components/editor/lite-text";
// hooks
import { useChat } from "@/hooks/store/use-chat";
import { useWorkspace } from "@/hooks/store/use-workspace";

export type TChatComposerBody = { body_html: string; body_json: Record<string, unknown> };

type Props = {
  workspaceSlug: string;
  channelId: string;
  placeholder: string;
  onSend: (body: TChatComposerBody) => void;
};

/** Attachments come with Step 14; until then the editor has no image upload. */
const noUploads = async (): Promise<string> => {
  throw new Error("Attachments are not supported in messages yet");
};

/**
 * The message box: Plane's lite rich-text editor with @mentions. Enter sends, Shift+Enter adds a line. The editor
 * clears at once; the store shows the message as pending until the API has it, with a retry if it fails. Unsent
 * text is kept in the store per channel, so it is still there after switching away and back.
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

  const send = () => {
    const document = editorRef.current?.getDocument();
    if (!document || isCommentEmpty(document.html)) return;
    onSend({ body_html: document.html, body_json: (document.json ?? {}) as Record<string, unknown> });
    editorRef.current?.clearEditor();
    setIsEmpty(true);
    setDraft(channelId, "");
  };

  return (
    <div className="flex items-end gap-2 rounded-md border border-subtle bg-layer-1 px-3 py-2">
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
          onEnterKeyPress={send}
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
        disabled={isEmpty}
        onClick={send}
      />
    </div>
  );
});
