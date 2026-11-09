/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { Avatar } from "@makeplane/propel/components/avatar";
import { getFileURL } from "@plane/utils";
// hooks
import { useMember } from "@/hooks/store/use-member";

type Props = {
  userId: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg";
};

export const MemberAvatar = observer(function MemberAvatar({ userId, size = "md" }: Props) {
  const { getUserDetails } = useMember();
  const user = userId ? getUserDetails(userId) : undefined;
  const name = user?.display_name ?? "";
  return (
    <Avatar
      alt={name}
      fallback={name[0]?.toUpperCase() ?? "?"}
      src={user?.avatar_url ? getFileURL(user.avatar_url) : undefined}
      size={size}
    />
  );
});
