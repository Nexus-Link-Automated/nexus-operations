/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatService, ChatServiceError } from "./chat.service";

const mocks = vi.hoisted(() => ({ uploadFile: vi.fn() }));

vi.mock("../file/file-upload.service", () => ({
  FileUploadService: class {
    uploadFile = mocks.uploadFile;
  },
}));

const file = new File(["hello"], "note.txt", { type: "text/plain" });
const slot = { asset_id: "asset-1", upload_data: { url: "https://storage.example", fields: { key: "k" } } };

function service() {
  const chat = new ChatService("http://api");
  const post = vi.spyOn(chat as unknown as { post: () => Promise<unknown> }, "post");
  const patch = vi.spyOn(chat as unknown as { patch: () => Promise<unknown> }, "patch");
  return { chat, post, patch };
}

describe("ChatService attachments", () => {
  afterEach(() => vi.clearAllMocks());

  it("asks for a slot, sends the file to storage, then says it finished", async () => {
    const { chat, post, patch } = service();
    post.mockResolvedValue({ data: slot });
    patch.mockResolvedValue({ data: undefined });

    const uploaded = await chat.uploadAttachment("acme", "c1", file);

    expect(post).toHaveBeenCalledWith("/api/workspaces/acme/chat/channels/c1/attachments/", {
      name: "note.txt",
      size: 5,
      type: "text/plain",
    });
    expect(mocks.uploadFile.mock.calls[0]![0]).toBe("https://storage.example");
    expect(patch).toHaveBeenCalledWith("/api/workspaces/acme/chat/channels/c1/attachments/asset-1/");
    expect(uploaded).toEqual({ id: "asset-1", name: "note.txt", type: "text/plain", size: 5 });
  });

  it("turns a refused slot into a ChatServiceError with the status", async () => {
    const { chat, post } = service();
    post.mockRejectedValue({ response: { status: 400, data: { type: ["no"] } } });
    await expect(chat.uploadAttachment("acme", "c1", file)).rejects.toSatisfy(
      (error) => error instanceof ChatServiceError && error.status === 400
    );
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("reports upload progress as a percentage", async () => {
    const { chat, post, patch } = service();
    post.mockResolvedValue({ data: slot });
    patch.mockResolvedValue({ data: undefined });
    const seen: number[] = [];
    mocks.uploadFile.mockImplementation(async (_url, _data, progress) => progress({ loaded: 1, total: 4 }));
    await chat.uploadAttachment("acme", "c1", file, (percent) => seen.push(percent));
    expect(seen).toEqual([25]);
  });
});
