/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { act, render } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chat: undefined as unknown as { totalUnread: number } }));

vi.mock("@/hooks/store/use-chat", () => ({ useChat: () => mocks.chat }));

const { ChatUnreadTitle } = await import("./unread-title");

/** Let the title watcher see what changed. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const setUnread = (count: number) =>
  act(() => {
    runInAction(() => {
      mocks.chat.totalUnread = count;
    });
  });

describe("ChatUnreadTitle", () => {
  beforeEach(() => {
    mocks.chat = observable({ totalUnread: 0 });
    document.title = "Messages";
  });

  it("leaves the title alone while nothing is unread", () => {
    render(<ChatUnreadTitle />);
    expect(document.title).toBe("Messages");
  });

  it("shows the unread count, follows it, and takes it away at zero", async () => {
    render(<ChatUnreadTitle />);
    await setUnread(3);
    expect(document.title).toBe("(3) Messages");
    await setUnread(150);
    expect(document.title).toBe("(99+) Messages");
    await setUnread(0);
    expect(document.title).toBe("Messages");
  });

  it("keeps the count in front of a title the page sets later", async () => {
    render(<ChatUnreadTitle />);
    await setUnread(2);
    document.title = "Work items";
    await flush();
    expect(document.title).toBe("(2) Work items");
    await setUnread(0);
    expect(document.title).toBe("Work items");
  });

  it("puts the page's own title back when it goes", async () => {
    const { unmount } = render(<ChatUnreadTitle />);
    await setUnread(4);
    expect(document.title).toBe("(4) Messages");
    unmount();
    expect(document.title).toBe("Messages");
  });
});
