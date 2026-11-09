/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";
import type { TPageVersion } from "@plane/types";
import type { EPageStoreType } from "@/hooks/store";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: vi.fn() }));
vi.mock("@plane/blocks/empty-state", () => ({ EmptyStateCompact: () => null }));
vi.mock("@makeplane/propel/components/badge", () => ({ Badge: () => null }));
vi.mock("@makeplane/propel/components/icon", () => ({ Icon: () => null }));
// Clicks always reach onClick, so the handler's own guard is exercised as well as the disabled state.
vi.mock("@makeplane/propel/components/button", () => ({
  Button: (props: { label: ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button type="button" data-disabled={String(Boolean(props.disabled))} onClick={props.onClick}>
      {props.label}
    </button>
  ),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { PageVersionsMainContent } from "./main-content";

const RESTORE = "common.actions.restore";
const VERSION = {
  id: "version-1",
  description_html: "<p>Saved text</p>",
  last_saved_at: "2026-01-01T00:00:00Z",
} as TPageVersion;

describe("PageVersionsMainContent", () => {
  it("does not restore until the version has loaded, then restores that version", async () => {
    let finishLoading: ((version: TPageVersion) => void) | undefined;
    const fetchVersionDetails = vi.fn(
      () =>
        new Promise<TPageVersion>((resolve) => {
          finishLoading = resolve;
        })
    );
    const handleRestore = vi.fn(() => Promise.resolve());

    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <PageVersionsMainContent
          activeVersion="version-1"
          editorComponent={() => null}
          fetchVersionDetails={fetchVersionDetails}
          handleClose={vi.fn()}
          handleRestore={handleRestore}
          pageId="page-1"
          restoreEnabled
          storeType={"PROJECT" as EPageStoreType}
        />
      </SWRConfig>
    );

    const restoreButton = screen.getByRole("button", { name: RESTORE });
    expect(restoreButton.dataset.disabled).toBe("true");
    await act(async () => {
      fireEvent.click(restoreButton);
      await Promise.resolve();
    });
    expect(handleRestore).not.toHaveBeenCalled();

    await act(async () => {
      finishLoading?.(VERSION);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: RESTORE }).dataset.disabled).toBe("false"));

    fireEvent.click(screen.getByRole("button", { name: RESTORE }));
    await waitFor(() => expect(handleRestore).toHaveBeenCalledWith("<p>Saved text</p>"));
  });
});
