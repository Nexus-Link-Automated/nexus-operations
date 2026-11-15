/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImagePickerPopover } from "./image-picker-popover";

const mocks = vi.hoisted(() => ({
  getUnsplashImages: vi.fn(),
  config: { has_unsplash_configured: true },
}));

vi.mock("@/hooks/store/use-instance", () => ({ useInstance: () => ({ config: mocks.config }) }));
vi.mock("@/services/file.service", () => ({
  FileService: class {
    getUnsplashImages = mocks.getUnsplashImages;
  },
}));

function Picker() {
  const { control } = useForm<{ cover_image: string }>();
  return <ImagePickerPopover label="Change cover" value={null} control={control} onChange={() => {}} />;
}

// A fresh SWR cache per test, so one test's response cannot satisfy another's request.
const renderPicker = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Picker />
    </SWRConfig>
  );

describe("ImagePickerPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.has_unsplash_configured = true;
    mocks.getUnsplashImages.mockResolvedValue([]);
  });

  it("does not call Unsplash while the picker is closed", async () => {
    renderPicker();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.getUnsplashImages).not.toHaveBeenCalled();
  });

  it("calls Unsplash once the picker is opened", async () => {
    renderPicker();
    fireEvent.click(screen.getByText("Change cover"));
    await waitFor(() => expect(mocks.getUnsplashImages).toHaveBeenCalledTimes(1));
  });

  it("does not call Unsplash when it is not configured, even when opened", async () => {
    mocks.config.has_unsplash_configured = false;
    renderPicker();
    fireEvent.click(screen.getByText("Change cover"));
    await screen.findByText("Upload");
    expect(mocks.getUnsplashImages).not.toHaveBeenCalled();
  });
});
