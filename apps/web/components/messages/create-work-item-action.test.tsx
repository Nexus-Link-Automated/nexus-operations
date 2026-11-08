/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TChatMessage, TIssue } from "@plane/types";

type ModalProps = {
  data: Partial<TIssue>;
  onSubmit: (issue: TIssue) => Promise<void>;
  onClose: () => void;
};

const mocks = vi.hoisted(() => ({
  chat: {
    userId: "me",
    channelMap: {} as Record<string, { project: string | null }>,
    linkWorkItem: vi.fn(),
  },
  joinedProjectIds: ["p1", "p2"],
  fetchProjectMembers: vi.fn(),
  memberIds: ["me", "ada"] as string[] | null,
  toast: vi.fn(),
  modal: undefined as ModalProps | undefined,
}));

vi.mock("@/hooks/store/use-chat", () => ({ useChat: () => mocks.chat }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ joinedProjectIds: mocks.joinedProjectIds }) }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    project: {
      fetchProjectMembers: mocks.fetchProjectMembers,
      getProjectMemberIds: () => mocks.memberIds,
    },
  }),
}));
vi.mock("@plane/blocks/toast", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setToast: (toast: unknown) => mocks.toast(toast),
}));
vi.mock("@/components/issues/issue-modal/modal", () => ({
  CreateUpdateIssueModal: (props: ModalProps) => {
    mocks.modal = props;
    return <div role="dialog" />;
  },
}));

const { ChatCreateWorkItemAction } = await import("./create-work-item-action");
const { mentionedUserIds, readLastWorkItemProject, writeLastWorkItemProject } = await import("./helpers");

const mention = (id: string, name = "user_mention") =>
  `<mention-component entity_name="${name}" entity_identifier="${id}"></mention-component>`;

const message = (overrides: Partial<TChatMessage> = {}) =>
  ({
    id: "m1",
    channel: "c1",
    body_html: "<p>login is broken</p>",
    body_stripped: "login is broken",
    ...overrides,
  }) as TChatMessage;

async function openForm(props = message()) {
  render(<ChatCreateWorkItemAction message={props} workspaceSlug="acme" />);
  await userEvent.click(screen.getByRole("button"));
  await screen.findByRole("dialog");
  return mocks.modal!;
}

describe("ChatCreateWorkItemAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modal = undefined;
    mocks.chat.channelMap = { c1: { project: null } };
    mocks.joinedProjectIds = ["p1", "p2"];
    mocks.memberIds = ["me", "ada"];
    mocks.fetchProjectMembers.mockResolvedValue(undefined);
    mocks.chat.linkWorkItem.mockResolvedValue(undefined);
  });
  afterEach(() => localStorage.clear());

  it("opens the form filled in from the message, assigned to whoever clicked", async () => {
    const { data } = await openForm();
    expect(data).toEqual({
      name: "login is broken",
      description_html: "<p>login is broken</p>",
      project_id: "p1",
      assignee_ids: ["me"],
    });
  });

  it("assigns the person mentioned, if they're in the project", async () => {
    const { data } = await openForm(message({ body_html: `<p>${mention("ada")} login is broken</p>` }));
    expect(data.assignee_ids).toEqual(["ada"]);
  });

  it("starts in the channel's project when it has one", async () => {
    mocks.chat.channelMap = { c1: { project: "p2" } };
    const { data } = await openForm();
    expect(data.project_id).toBe("p2");
    expect(mocks.fetchProjectMembers).toHaveBeenCalledWith("acme", "p2");
  });

  it("still opens when the member list can't be loaded, with nobody assigned", async () => {
    mocks.fetchProjectMembers.mockRejectedValue(new Error("offline"));
    mocks.memberIds = null;
    const { data } = await openForm();
    expect(data.assignee_ids).toEqual([]);
    expect(data.name).toBe("login is broken");
  });

  it("links the saved work item to the message, and remembers its project for next time", async () => {
    const { onSubmit } = await openForm();
    await onSubmit({ id: "i1", project_id: "p2" } as TIssue);
    expect(mocks.chat.linkWorkItem).toHaveBeenCalledWith("c1", "m1", "i1");
    expect(localStorage.getItem("chat-work-item-project:acme")).toBe("p2");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("says so when the work item was saved but couldn't be linked", async () => {
    mocks.chat.linkWorkItem.mockRejectedValue(new Error("offline"));
    const { onSubmit } = await openForm();
    await expect(onSubmit({ id: "i1", project_id: "p1" } as TIssue)).resolves.toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});

describe("reading a message for its work item", () => {
  describe("mentionedUserIds", () => {
    it("lists people in the order mentioned, once each", () => {
      expect(mentionedUserIds(`<p>${mention("b")} and ${mention("a")} and ${mention("b")}</p>`)).toEqual(["b", "a"]);
    });

    it("ignores other kinds of mention", () => {
      expect(mentionedUserIds(`<p>${mention("x", "issue_mention")}</p>`)).toEqual([]);
    });
  });

  describe("the last used project", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      localStorage.clear();
    });

    it("is remembered per workspace", () => {
      writeLastWorkItemProject("acme", "p1");
      expect(readLastWorkItemProject("acme")).toBe("p1");
      expect(readLastWorkItemProject("other")).toBeNull();
    });

    it("doesn't throw when storage is blocked", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      expect(readLastWorkItemProject("acme")).toBeNull();
      expect(() => writeLastWorkItemProject("acme", "p1")).not.toThrow();
    });
  });
});
