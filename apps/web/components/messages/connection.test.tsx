/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chat: {
    start: vi.fn(() => Promise.resolve()),
    reconnect: vi.fn(),
    setDocumentVisible: vi.fn(),
    noteActivity: vi.fn(),
  },
}));

vi.mock("@/hooks/store/use-chat", () => ({ useChat: () => mocks.chat }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));

const { ChatConnection } = await import("./connection");

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("ChatConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it.each(["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"])(
    "counts %s as activity",
    (type) => {
      render(<ChatConnection workspaceSlug="acme" />);
      mocks.chat.noteActivity.mockClear();
      window.dispatchEvent(new Event(type));
      expect(mocks.chat.noteActivity).toHaveBeenCalledTimes(1);
    }
  );

  it("sees activity inside a component that stops propagation", () => {
    const { getByTestId } = render(
      <>
        <ChatConnection workspaceSlug="acme" />
        <button data-testid="inner" onKeyDown={(event) => event.stopPropagation()} />
      </>
    );
    mocks.chat.noteActivity.mockClear();
    fireEvent.keyDown(getByTestId("inner"), { key: "a" });
    expect(mocks.chat.noteActivity).toHaveBeenCalledTimes(1);
  });

  it("counts coming back to the tab, but not leaving it", () => {
    render(<ChatConnection workspaceSlug="acme" />);
    mocks.chat.noteActivity.mockClear();
    setVisibility("hidden");
    expect(mocks.chat.noteActivity).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(mocks.chat.noteActivity).toHaveBeenCalledTimes(1);
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = render(<ChatConnection workspaceSlug="acme" />);
    unmount();
    mocks.chat.noteActivity.mockClear();
    window.dispatchEvent(new Event("keydown"));
    setVisibility("visible");
    expect(mocks.chat.noteActivity).not.toHaveBeenCalled();
  });
});
