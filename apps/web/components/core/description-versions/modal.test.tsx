/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TDescriptionVersion } from "@plane/types";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/blocks/toast", () => ({ setToast: vi.fn() }));
vi.mock("@/components/editor/rich-text", () => ({ RichTextEditor: () => null }));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: () => undefined }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "workspace-1" }) }),
}));
// Clicks always reach onClick, so the handler's own guard is exercised as well as the disabled state.
vi.mock("@makeplane/propel/components/button", () => ({
  Button: (props: { label: ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button type="button" data-disabled={String(Boolean(props.disabled))} onClick={props.onClick}>
      {props.label}
    </button>
  ),
}));

// oxlint-disable-next-line import/first -- the module under test must load after the mocks
import { DescriptionVersionsModal } from "./modal";

const RESTORE = "common.actions.restore";
const VERSION = { id: "version-1", last_saved_at: "2026-01-01T00:00:00Z" } as TDescriptionVersion;

describe("DescriptionVersionsModal", () => {
  it("does not restore until the version has loaded, then restores that version", () => {
    const handleClose = vi.fn();
    const handleRestore = vi.fn();
    const modal = (activeVersionDescription: string | undefined) => (
      <DescriptionVersionsModal
        activeVersionDescription={activeVersionDescription}
        activeVersionDetails={VERSION}
        handleClose={handleClose}
        handleNavigation={vi.fn()}
        handleRestore={handleRestore}
        isNextDisabled
        isOpen
        isPrevDisabled
        isRestoreDisabled={false}
        projectId="project-1"
        workspaceSlug="acme"
      />
    );

    const { rerender } = render(modal(undefined));

    expect(screen.getByRole("button", { name: RESTORE }).dataset.disabled).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: RESTORE }));
    expect(handleRestore).not.toHaveBeenCalled();
    expect(handleClose).not.toHaveBeenCalled();

    rerender(modal("<p>Saved text</p>"));

    expect(screen.getByRole("button", { name: RESTORE }).dataset.disabled).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: RESTORE }));
    expect(handleRestore).toHaveBeenCalledWith("<p>Saved text</p>");
    expect(handleClose).toHaveBeenCalledOnce();
  });
});
