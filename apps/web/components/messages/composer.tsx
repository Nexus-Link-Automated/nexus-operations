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
import type { EditorRefApi, TMentionSection } from "@plane/editor";
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
import { ChatAgentAvatar } from "./member-avatar";

export type TChatComposerBody = TChatOutgoingMessage & { body_json: Record<string, unknown> };

type Props = {
  workspaceSlug: string;
  channelId: string;
  /** Replying in this thread (its first message) rather than writing in the channel. */
  parentId?: string;
  placeholder: string;
  onSend: (body: TChatComposerBody) => void;
};

/** Files go on the message as attachments, never inside the text, so the editor itself takes no uploads. */
const noUploads = async (): Promise<string> => {
  throw new Error("Files are attached to a message, not embedded in it");
};

/** How many agents the mention list shows at most. */
const MAX_AGENT_SUGGESTIONS = 5;

/**
 * The message box: Plane's lite rich-text editor with @mentions. Enter sends, Shift+Enter adds a line. The editor
 * clears at once; the store shows the message as pending until the API has it, with a retry if it fails. Unsent
 * text is kept in the store per channel, so it is still there after switching away and back. Files upload as soon
 * as they are added, and sending waits for all of them.
 *
 * The mention list also offers the channel's agents, tagged, to someone who may run agents: mentioning one asks it to
 * reply in the thread.
 */
export const ChatComposer = observer(function ChatComposer({
  workspaceSlug,
  channelId,
  parentId,
  placeholder,
  onSend,
}: Props) {
  const { t } = useTranslation();
  const { getWorkspaceBySlug } = useWorkspace();
  const { getMentionableAgents, getDraft, setDraft } = useChat();
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id ?? "";
  const editorRef = useRef<EditorRefApi>(null);
  // A thread's reply box keeps its own unsent text, apart from the channel's.
  const draftKey = parentId ? `${channelId}/${parentId}` : channelId;
  // Read once: the editor takes its initial value only when it mounts.
  const [draft] = useState(() => getDraft(draftKey));
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
    setDraft(draftKey, "");
  };
  // The editor is built once and keeps the callback it was given, which needs the current state of the files.
  const latestSend = useRef(send);
  latestSend.current = send;
  const handleEnter = useCallback(() => latestSend.current(), []);

  // Read when the list opens: the editor keeps the first callback it was given.
  const agentSections = (query: string): TMentionSection[] => {
    const needle = query.trim().toLowerCase();
    const items = getMentionableAgents(channelId)
      .filter((agent) => !needle || agent.name.toLowerCase().includes(needle) || agent.slug.includes(needle))
      .slice(0, MAX_AGENT_SUGGESTIONS)
      .map((agent) => ({
        id: agent.agent,
        entity_identifier: agent.agent,
        entity_name: "agent_mention" as const,
        title: agent.name,
        subTitle: t("messages.agent.tag"),
        icon: <ChatAgentAvatar adapter={agent.adapter} size="xs" />,
      }));
    return items.length > 0 ? [{ key: "agents", title: t("messages.agent.mention_section"), items }] : [];
  };
  const latestAgentSections = useRef(agentSections);
  latestAgentSections.current = agentSections;
  const extraMentionSections = useCallback((query: string) => latestAgentSections.current(query), []);

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
            id={parentId ? `chat-reply-${parentId}` : `chat-composer-${channelId}`}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            initialValue={draft ?? "<p></p>"}
            // Opening a conversation, or a thread, means typing in it.
            autofocus
            placeholder={placeholder}
            onChange={(_json, html) => {
              const empty = isCommentEmpty(html);
              setIsEmpty(empty);
              setDraft(draftKey, empty ? "" : html);
            }}
            onEnterKeyPress={handleEnter}
            extraMentionSections={extraMentionSections}
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
