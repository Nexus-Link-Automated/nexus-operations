/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export enum EInstanceStatus {
  ERROR = "ERROR",
  NOT_YET_READY = "NOT_YET_READY",
}

/** The placeholder the admin API returns for an encrypted setting that is set. Sending it back keeps the value. */
export const INSTANCE_CONFIGURATION_MASK = "********";

export type TInstanceStatus = {
  status: EInstanceStatus | undefined;
  data?: object;
};
