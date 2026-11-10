/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EPageStoreType } from "@/hooks/store";
import type { TPageInstance } from "@/store/pages/base-page";

const mocks = vi.hoisted(() => ({ setToast: vi.fn(), pages: new Map<string, unknown>() }));

vi.mock("@plane/blocks/toast", () => ({ setToast: mocks.setToast }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/store", () => ({
  usePageStore: () => ({ getPageById: (id: string) => mocks.pages.get(id), removePage: vi.fn() }),
}));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@makeplane/propel/components/badge", () => ({ Badge: ({ label }: { label: string }) => label }));
vi.mock("@makeplane/propel/components/icon", () => ({ Icon: () => null }));

// oxlint-disable-next-line import/first -- the modules under test must load after the mocks
import { PageSyncingBadge } from "@/components/pages/header/syncing-badge";
// oxlint-disable-next-line import/first
import { useRealtimePageEvents } from "./use-realtime-page-events";

const saveError = {
  error_message: "Unable to save the page. Please try again.",
  error_type: "store" as const,
  user_id: "user-1",
};

const fakePage = () => {
  const page = {
    id: "page-1",
    hasSaveError: false,
    is_locked: false,
    archived_at: null,
    setHasSaveError: (value: boolean) => {
      page.hasSaveError = value;
    },
    mutateProperties: vi.fn(),
  };
  mocks.pages.set(page.id, page);
  return page;
};

const renderEvents = (page: ReturnType<typeof fakePage>) =>
  renderHook(() =>
    useRealtimePageEvents({
      page: page as unknown as TPageInstance,
      storeType: "PROJECT_PAGE" as EPageStoreType,
      getUserDetails: () => undefined,
      handlers: { getRedirectionLink: () => "/pages" } as never,
    })
  ).result.current.updatePageProperties;

describe("useRealtimePageEvents save state", () => {
  beforeEach(() => {
    mocks.setToast.mockClear();
    mocks.pages.clear();
  });

  it("keeps a page marked as not saved from a failed save until the server reports a save", () => {
    const page = fakePage();
    const updatePageProperties = renderEvents(page);

    act(() => updatePageProperties("page-1", "error", saveError));
    act(() => updatePageProperties("page-1", "error", saveError));
    expect(page.hasSaveError).toBe(true);
    // repeated failures keep the header state without a toast each time
    expect(mocks.setToast).toHaveBeenCalledTimes(1);
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to save page" }));

    act(() => updatePageProperties("page-1", "saved", {}));
    expect(page.hasSaveError).toBe(false);

    act(() => updatePageProperties("page-1", "error", saveError));
    expect(mocks.setToast).toHaveBeenCalledTimes(2);
  });

  it("does not mark the page for a failed load", () => {
    const page = fakePage();
    const updatePageProperties = renderEvents(page);
    act(() => updatePageProperties("page-1", "error", { ...saveError, error_type: "fetch" }));
    expect(page.hasSaveError).toBe(false);
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to load page" }));
  });
});

describe("PageSyncingBadge", () => {
  it("shows a not-saved state while connected", () => {
    render(<PageSyncingBadge syncStatus="synced" hasSaveError />);
    expect(screen.getByText("Not saved")).toBeTruthy();
  });

  it("shows nothing when synced and saved", () => {
    const { container } = render(<PageSyncingBadge syncStatus="synced" />);
    expect(container.textContent).toBe("");
  });
});
