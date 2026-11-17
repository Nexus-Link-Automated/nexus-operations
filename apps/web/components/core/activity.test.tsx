/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { render, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IIssueActivity } from "@plane/types";
import { ActivityMessage } from "./activity";

const mocks = vi.hoisted(() => ({ fetchWorkspaceLabels: vi.fn() }));

vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "acme" }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/store/use-label", () => ({
  useLabel: () => ({ workspaceLabels: undefined, fetchWorkspaceLabels: mocks.fetchWorkspaceLabels }),
}));

const labelActivity = (id: string, added: boolean) =>
  ({
    id,
    field: "labels",
    old_value: added ? "" : `label-${id}`,
    new_value: added ? `label-${id}` : "",
    old_identifier: added ? null : id,
    new_identifier: added ? id : null,
  }) as unknown as IIssueActivity;

describe("ActivityMessage label rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the workspace labels once for a feed with several label changes", async () => {
    mocks.fetchWorkspaceLabels.mockResolvedValue([]);
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        {[labelActivity("a", true), labelActivity("b", false), labelActivity("c", true)].map((activity) => (
          <ActivityMessage key={activity.id} activity={activity} />
        ))}
      </SWRConfig>
    );

    await waitFor(() => expect(mocks.fetchWorkspaceLabels).toHaveBeenCalled());
    expect(mocks.fetchWorkspaceLabels).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWorkspaceLabels).toHaveBeenCalledWith("acme");
  });
});
