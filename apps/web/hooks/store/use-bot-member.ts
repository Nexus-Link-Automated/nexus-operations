/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useContext } from "react";
// mobx store
import { StoreContext } from "@/lib/store-context";
// types
import type { IBotMemberStore } from "@/store/bot-member.store";

export const useBotMember = (): IBotMemberStore => {
  const context = useContext(StoreContext);
  if (context === undefined) throw new Error("useBotMember must be used within StoreProvider");
  return context.botMember;
};
