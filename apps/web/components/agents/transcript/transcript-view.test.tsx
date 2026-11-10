/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySessionUpdate, createTranscript } from "@plane/acp-client";
import type { PendingPermission, TranscriptState } from "@plane/acp-client";
import { fireEvent } from "@testing-library/react";
import { formatJson } from "../helpers";
import { TranscriptView } from "./transcript-view";

// The two costly steps an item repeats whenever it renders.
const markdownRenders = vi.hoisted(() => vi.fn<(text: string) => void>());
vi.mock("@/components/ui/markdown-to-component", () => ({
  MarkdownRenderer: ({ markdown }: { markdown: string }) => {
    markdownRenders(markdown);
    return <p>{markdown}</p>;
  },
}));
vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return { ...actual, formatJson: vi.fn(actual.formatJson) };
});

type TUpdate = Parameters<typeof applySessionUpdate>[1];

const chunk = (messageId: string, text: string): TUpdate => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
});
const TOOL_CALL: TUpdate = {
  sessionUpdate: "tool_call",
  toolCallId: "t1",
  title: "Run ls",
  kind: "execute",
  status: "pending",
  rawInput: { command: "ls" },
};

const box = (top: number, height: number) => ({ top, bottom: top + height }) as DOMRect;

const apply = (updates: TUpdate[], from = createTranscript()): TranscriptState =>
  updates.reduce(applySessionUpdate, from);

const onRespondToPermission = vi.fn();
const view = (state: TranscriptState, permissions: readonly PendingPermission[] = []) => (
  <TranscriptView
    items={state.items}
    permissions={permissions}
    prompting
    onRespondToPermission={onRespondToPermission}
  />
);

beforeEach(() => {
  markdownRenders.mockClear();
  vi.mocked(formatJson).mockClear();
});

describe("TranscriptView", () => {
  it("does not re-render stable items when another item streams", () => {
    const state = apply([chunk("m1", "First answer"), TOOL_CALL, chunk("m2", "Sec")]);
    const { rerender } = render(view(state));
    expect(markdownRenders.mock.calls).toEqual([["First answer"], ["Sec"]]);
    expect(formatJson).toHaveBeenCalled();
    markdownRenders.mockClear();
    vi.mocked(formatJson).mockClear();

    rerender(view(apply([chunk("m2", "ond")], state)));

    expect(screen.getByText("Second")).toBeTruthy();
    expect(markdownRenders.mock.calls).toEqual([["Second"]]);
    expect(formatJson).not.toHaveBeenCalled();
  });

  describe("an approval prompt out of view", () => {
    const permission: PendingPermission = {
      id: "perm-1",
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    };
    // The transcript shows 0-300px; the prompt sits wherever `promptTop` says.
    let promptTop = 0;
    beforeEach(() => {
      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
      rect.mockImplementation(function (this: HTMLElement) {
        return this.matches("[data-permission-prompt]") ? box(promptTop, 80) : box(0, 300);
      });
      return () => rect.mockRestore();
    });
    const banner = () => screen.queryByRole("button", { name: /Approval needed/ });

    it("gets a banner that jumps to it, until it is in view", () => {
      promptTop = 900;
      render(view(apply([TOOL_CALL]), [permission]));
      // jsdom does not scroll.
      const prompt = screen.getByRole("group", { name: "Allow this action?" });
      const scrollIntoView = vi.fn();
      prompt.scrollIntoView = scrollIntoView;

      fireEvent.click(banner()!);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(prompt);

      promptTop = 100;
      fireEvent.scroll(screen.getByRole("log"));
      expect(banner()).toBeNull();
    });

    it("gets no banner while it is in view, or once it is answered", () => {
      promptTop = 100;
      const { rerender } = render(view(apply([TOOL_CALL]), [permission]));
      expect(banner()).toBeNull();

      promptTop = -200;
      fireEvent.scroll(screen.getByRole("log"));
      expect(banner()).toBeTruthy();
      rerender(view(apply([TOOL_CALL])));
      expect(banner()).toBeNull();
    });
  });

  it("re-renders a tool card when its permission prompt arrives", async () => {
    const state = apply([TOOL_CALL]);
    const { rerender } = render(view(state));
    const permission: PendingPermission = {
      id: "perm-1",
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Run ls" },
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    };

    rerender(view(state, [permission]));

    expect(await screen.findByRole("group", { name: "Allow this action?" })).toBeTruthy();
  });
});
