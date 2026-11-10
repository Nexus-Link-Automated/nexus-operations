/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { forwardRef, useImperativeHandle } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
// plane imports
import { ChatServiceError } from "@plane/services";

const mocks = vi.hoisted(() => ({
  chat: {} as {
    uploadAttachment: ReturnType<typeof vi.fn>;
    deleteAttachment: ReturnType<typeof vi.fn>;
    getDraft: (channelId: string) => string | undefined;
    setDraft: (channelId: string, html: string) => void;
    getMentionableAgents?: (channelId: string) => unknown[];
  },
  html: "<p></p>",
  clearEditor: vi.fn(),
  editorProps: {} as { extraMentionSections?: (query: string) => unknown[] },
}));

vi.mock("@/hooks/store/use-chat", () => ({ useChat: () => mocks.chat }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws-1" }) }),
}));
vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 1000 }) }));
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: forwardRef(function Editor(props, ref) {
    mocks.editorProps = props as typeof mocks.editorProps;
    useImperativeHandle(ref, () => ({
      getDocument: () => ({ html: mocks.html, json: {} }),
      clearEditor: mocks.clearEditor,
    }));
    return <div data-testid="editor" />;
  }),
}));

const { ChatComposer } = await import("./composer");

// The test setup has no ICU formatter, so `t()` returns a template with placeholders as they are.
const byTemplate = (fixed: string) => (content: string) => content.includes(fixed);

const uploaded = (name: string) => ({ id: `asset-${name}`, name, type: "image/png", size: 10 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const renderComposer = (onSend = vi.fn()) => {
  render(<ChatComposer workspaceSlug="acme" channelId="c1" placeholder="Message" onSend={onSend} />);
  return onSend;
};

const attach = async (...files: File[]) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, files);
};

const sendButton = () => screen.getByRole("button", { name: "Send message" });

describe("ChatComposer attachments", () => {
  beforeEach(() => {
    mocks.html = "<p></p>";
    mocks.chat = {
      uploadAttachment: vi.fn(),
      deleteAttachment: vi.fn(),
      getDraft: () => undefined,
      setDraft: () => undefined,
    };
    URL.createObjectURL = vi.fn(() => "blob:local");
    URL.revokeObjectURL = vi.fn();
  });

  it("uploads a file as soon as it is picked, and shows its progress", async () => {
    const upload = deferred<ReturnType<typeof uploaded>>();
    let report: ((percent: number) => void) | undefined;
    mocks.chat.uploadAttachment.mockImplementation((_channel, _file, onProgress) => {
      report = onProgress;
      return upload.promise;
    });
    renderComposer();
    await attach(new File(["x"], "a.png", { type: "image/png" }));
    expect(mocks.chat.uploadAttachment).toHaveBeenCalledWith("c1", expect.any(File), expect.any(Function));
    const bar = await screen.findByRole("progressbar");
    act(() => report?.(42));
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("blocks sending while a file is uploading", async () => {
    const upload = deferred<ReturnType<typeof uploaded>>();
    mocks.chat.uploadAttachment.mockReturnValue(upload.promise);
    mocks.html = "<p>hello</p>";
    const onSend = renderComposer();
    await attach(new File(["x"], "a.png", { type: "image/png" }));
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    await act(async () => upload.resolve(uploaded("a.png")));
    await waitFor(() => expect(sendButton().hasAttribute("disabled")).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].attachments).toEqual([uploaded("a.png")]);
  });

  it("can send a message that is only a file", async () => {
    mocks.chat.uploadAttachment.mockResolvedValue(uploaded("a.png"));
    const onSend = renderComposer();
    await attach(new File(["x"], "a.png", { type: "image/png" }));
    await waitFor(() => expect(sendButton().hasAttribute("disabled")).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith({
      body_html: "<p></p>",
      body_json: {},
      attachments: [uploaded("a.png")],
    });
    expect(await screen.queryByText("a.png")).toBeNull();
  });

  it("has nothing to send without text or a file", () => {
    const onSend = renderComposer();
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("removes a finished file before sending, from the server too", async () => {
    mocks.chat.uploadAttachment.mockResolvedValue(uploaded("a.png"));
    renderComposer();
    await attach(new File(["x"], "a.png", { type: "image/png" }));
    await userEvent.click(await screen.findByRole("button", { name: byTemplate("Remove") }));
    expect(screen.queryByText("a.png")).toBeNull();
    expect(mocks.chat.deleteAttachment).toHaveBeenCalledWith("c1", "asset-a.png");
  });

  it("removes a file that is still uploading once its upload lands", async () => {
    const upload = deferred<ReturnType<typeof uploaded>>();
    mocks.chat.uploadAttachment.mockReturnValue(upload.promise);
    renderComposer();
    await attach(new File(["x"], "a.png", { type: "image/png" }));
    await userEvent.click(screen.getByRole("button", { name: byTemplate("Remove") }));
    expect(screen.queryByText("a.png")).toBeNull();
    await act(async () => upload.resolve(uploaded("a.png")));
    expect(mocks.chat.deleteAttachment).toHaveBeenCalledWith("c1", "asset-a.png");
  });

  it("names a file that is too large, and doesn't upload it", async () => {
    renderComposer();
    await attach(new File(["x".repeat(2000)], "big.png", { type: "image/png" }));
    expect((await screen.findByRole("alert")).textContent).toContain("larger than");
    expect(mocks.chat.uploadAttachment).not.toHaveBeenCalled();
    expect(sendButton().hasAttribute("disabled")).toBe(true);
  });

  it("says a refused file isn't allowed", async () => {
    mocks.chat.uploadAttachment.mockRejectedValue(new ChatServiceError(400, { type: ["no"] }));
    renderComposer();
    await attach(new File(["x"], "a.exe", { type: "application/x-msdownload" }));
    expect((await screen.findByRole("alert")).textContent).toContain("isn't allowed");
  });

  it("says when an upload failed for another reason", async () => {
    mocks.chat.uploadAttachment.mockRejectedValue(new Error("network"));
    renderComposer();
    await attach(new File(["x"], "a.png", { type: "image/png" }));
    expect((await screen.findByRole("alert")).textContent).toContain("couldn't be uploaded");
  });

  it("keeps a failed file listed after sending the rest", async () => {
    mocks.chat.uploadAttachment.mockResolvedValueOnce(uploaded("good.png")).mockRejectedValueOnce(new Error("network"));
    mocks.html = "<p>hi</p>";
    renderComposer();
    await attach(new File(["x"], "good.png", { type: "image/png" }), new File(["x"], "bad.png", { type: "image/png" }));
    await waitFor(() => expect(sendButton().hasAttribute("disabled")).toBe(false));
    await userEvent.click(sendButton());
    expect(screen.queryByText("good.png")).toBeNull();
    expect(screen.getByText("bad.png")).toBeTruthy();
  });

  it("refuses more files than a message can carry", async () => {
    mocks.chat.uploadAttachment.mockImplementation(async (_channel, file: File) => uploaded(file.name));
    renderComposer();
    await attach(...Array.from({ length: 11 }, (_, i) => new File(["x"], `f${i}.png`, { type: "image/png" })));
    expect((await screen.findByRole("alert")).textContent).toContain("attachments");
    expect(mocks.chat.uploadAttachment).toHaveBeenCalledTimes(10);
  });
});

const agent = (id: string, name: string) => ({
  id: `seat-${id}`,
  channel: "c1",
  agent: id,
  slug: id,
  name,
  description: "",
  adapter: "claude",
  permission_level: "ask_writes",
  is_available: true,
  added_by: null,
  added_at: "2026-01-01T00:00:00Z",
});

describe("ChatComposer agent mentions", () => {
  it("lists the channel's agents the user may mention, tagged, before the people", () => {
    const getMentionableAgents = vi.fn(() => [agent("maia", "Maia"), agent("scout", "Scout")]);
    mocks.chat = { ...mocks.chat, getMentionableAgents };
    renderComposer();
    const [section] = mocks.editorProps.extraMentionSections!("ma") as {
      key: string;
      title: string;
      items: { entity_name: string; entity_identifier: string; title: string; subTitle: string }[];
    }[];
    expect(getMentionableAgents).toHaveBeenCalledWith("c1");
    expect(section!.title).toBe("Agents");
    expect(
      section!.items.map(({ entity_name, entity_identifier, title, subTitle }) => ({
        entity_name,
        entity_identifier,
        title,
        subTitle,
      }))
    ).toEqual([{ entity_name: "agent_mention", entity_identifier: "maia", title: "Maia", subTitle: "Agent" }]);
    expect(mocks.editorProps.extraMentionSections!("")[0]).toMatchObject({
      items: [{ title: "Maia" }, { title: "Scout" }],
    });
  });

  it("lists none when there are none to mention (a guest, a DM, a channel without agents)", () => {
    mocks.chat = { ...mocks.chat, getMentionableAgents: () => [] };
    renderComposer();
    expect(mocks.editorProps.extraMentionSections!("ma")).toEqual([]);
  });
});
