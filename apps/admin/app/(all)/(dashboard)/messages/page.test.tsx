/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TInstanceChatSettings, TMessageExport } from "@plane/types";
import InstanceMessagesPage from "./page";

const service = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  listExports: vi.fn(),
  createExport: vi.fn(),
  downloadUrl: vi.fn(),
}));

vi.mock("@plane/services", () => ({
  InstanceChatService: class {
    settings = service.settings;
    updateSettings = service.updateSettings;
    listExports = service.listExports;
    createExport = service.createExport;
    downloadUrl = service.downloadUrl;
  },
}));
vi.mock("@plane/blocks/toast", () => ({ setToast: vi.fn() }));
vi.mock("@/hooks/store", () => ({
  useWorkspace: () => ({
    workspaceIds: ["w1"],
    getWorkspaceById: () => ({ id: "w1", name: "Acme", slug: "acme" }),
    fetchWorkspaces: vi.fn(async () => []),
    fetchNextWorkspaces: vi.fn(async () => []),
    paginationInfo: undefined,
  }),
}));

const SETTINGS: TInstanceChatSettings = {
  retention_days: 0,
  min_retention_days: 30,
  max_retention_days: 36500,
  export_expiry_hours: 24,
  rate_limits: { send: ["30/minute", "500/hour"], read: ["120/minute"] },
};

const READY: TMessageExport = {
  id: "e1",
  workspace_id: "w1",
  workspace_slug: "acme",
  workspace_name: "Acme",
  requested_by_id: "u1",
  requested_by_email: "god@example.com",
  include_private: false,
  status: "ready",
  size: 2048,
  channel_count: 3,
  message_count: 40,
  created_at: "2026-11-10T10:00:00Z",
  completed_at: "2026-11-10T10:01:00Z",
  expires_at: "2026-11-11T10:01:00Z",
  can_download: true,
};

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <InstanceMessagesPage {...({} as Parameters<typeof InstanceMessagesPage>[0])} />
    </SWRConfig>
  );
}

const assign = vi.fn();

beforeEach(() => {
  // jsdom has no PointerEvent, which Base UI's switch dispatches on click.
  window.PointerEvent ??= MouseEvent as unknown as typeof PointerEvent;
  for (const fn of Object.values(service)) fn.mockReset();
  service.settings.mockResolvedValue(SETTINGS);
  service.listExports.mockResolvedValue([]);
  vi.stubGlobal("location", { ...window.location, assign });
  assign.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("message retention", () => {
  it("asks before turning deletion on, then saves the days", async () => {
    service.updateSettings.mockResolvedValue({ ...SETTINGS, retention_days: 90 });
    renderPage();
    await userEvent.click(await screen.findByRole("switch", { name: /Delete old messages/ }));
    const days = screen.getByLabelText(/Keep messages for/);
    await userEvent.clear(days);
    await userEvent.type(days, "90");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // The test setup has no ICU formatting, so placeholders stay as they are.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/permanently delete every message older than/)).toBeTruthy();
    expect(service.updateSettings).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete older messages" }));
    await waitFor(() => expect(service.updateSettings).toHaveBeenCalledWith({ retention_days: 90 }));
  });

  it("refuses fewer days than the minimum", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("switch", { name: /Delete old messages/ }));
    const days = screen.getByLabelText(/Keep messages for/);
    await userEvent.clear(days);
    await userEvent.type(days, "29");
    expect(screen.getByText(/Enter a whole number of days/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns deletion off without asking", async () => {
    service.settings.mockResolvedValue({ ...SETTINGS, retention_days: 90 });
    service.updateSettings.mockResolvedValue(SETTINGS);
    renderPage();
    await userEvent.click(await screen.findByRole("switch", { name: /Delete old messages/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(service.updateSettings).toHaveBeenCalledWith({ retention_days: 0 }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("exports", () => {
  it("starts an export of public channels unless private ones are asked for", async () => {
    service.createExport.mockResolvedValue({ ...READY, id: "e2", status: "queued", can_download: false });
    renderPage();
    await userEvent.click(await screen.findByRole("combobox", { name: "Workspace" }));
    await userEvent.click(await screen.findByRole("option", { name: "Acme (acme)" }));
    await userEvent.click(screen.getByRole("switch", { name: /Include private channels/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start export" }));
    await waitFor(() =>
      expect(service.createExport).toHaveBeenCalledWith({ workspace_id: "w1", include_private: true })
    );
    expect(await screen.findByText("Queued")).toBeTruthy();
  });

  it("lists past exports and downloads a ready one through a fresh link", async () => {
    service.listExports.mockResolvedValue([READY, { ...READY, id: "e0", status: "expired", can_download: false }]);
    service.downloadUrl.mockResolvedValue("https://storage.example/signed");
    renderPage();
    const list = await screen.findByRole("list", { name: "Past exports" });
    expect(within(list).getAllByText(/^Started by/)).toHaveLength(2);
    expect(within(list).getByText("Expired")).toBeTruthy();
    const downloads = within(list).getAllByRole("button", { name: /^Download the export of/ });
    expect(downloads).toHaveLength(1);
    await userEvent.click(downloads[0]!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://storage.example/signed"));
    expect(service.downloadUrl).toHaveBeenCalledWith("e1");
  });
});

describe("rate limits", () => {
  it("shows each limit's rates", async () => {
    renderPage();
    // The test setup has no ICU formatting, so "{count}" stays as it is.
    expect(await screen.findByText(/^\{count\} per minute, \{count\} per hour$/)).toBeTruthy();
    expect(screen.getByText("Send a message or reply")).toBeTruthy();
    expect(screen.getByText("Mark as read")).toBeTruthy();
    expect(screen.queryByText("Search messages")).toBeNull();
  });
});
