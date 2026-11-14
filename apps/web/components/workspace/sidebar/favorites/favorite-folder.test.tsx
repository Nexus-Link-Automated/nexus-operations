/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IFavorite } from "@plane/types";

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/i18n")>()),
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "acme" }) }));
vi.mock("@/hooks/store/use-favorite", () => ({ useFavorite: () => ({ fetchGroupedFavorites: vi.fn() }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("./favorite-items", () => ({ FavoriteRoot: () => null }));
vi.mock("./new-fav-folder", () => ({ NewFavoriteFolder: () => null }));

const { FavoriteFolder } = await import("./favorite-folder");

const child = (id: string) => ({ id, entity_type: "project", is_folder: false, children: [] }) as unknown as IFavorite;

const folder = (children: IFavorite[]) =>
  ({
    id: "folder-1",
    name: "Launch",
    is_folder: true,
    entity_type: "folder",
    sort_order: 1,
    sequence: 1,
    children,
  }) as unknown as IFavorite;

const handleRemoveFromFavorites = vi.fn();

const renderFolder = (favorite: IFavorite) =>
  render(
    <FavoriteFolder
      isLastChild
      favorite={favorite}
      handleRemoveFromFavorites={handleRemoveFromFavorites}
      handleRemoveFromFavoritesFolder={vi.fn()}
      handleDrop={vi.fn()}
    />
  );

const chooseRemove = async () => {
  await userEvent.click(screen.getByRole("button", { name: "aria_labels.projects_sidebar.toggle_quick_actions_menu" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "remove_from_favorites" }));
};

describe("removing a favorites folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks before removing a folder that holds favorites", async () => {
    const favorite = folder([child("a"), child("b")]);
    renderFolder(favorite);

    await chooseRemove();

    const dialog = await screen.findByRole("alertdialog", { name: "remove_favorite_folder_title" });
    expect(dialog.textContent).toContain('"name":"Launch"');
    expect(dialog.textContent).toContain('"count":2');
    expect(handleRemoveFromFavorites).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "remove" }));
    expect(handleRemoveFromFavorites).toHaveBeenCalledExactlyOnceWith(favorite);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the folder when the confirmation is cancelled", async () => {
    renderFolder(folder([child("a")]));

    await chooseRemove();
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(handleRemoveFromFavorites).not.toHaveBeenCalled();
  });

  it("removes an empty folder straight away", async () => {
    const favorite = folder([]);
    renderFolder(favorite);

    await chooseRemove();

    expect(handleRemoveFromFavorites).toHaveBeenCalledExactlyOnceWith(favorite);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
