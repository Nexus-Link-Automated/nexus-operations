/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { TInstanceChatSettings, TMessageExport, TMessageExportCreate } from "@plane/types";
import { APIService } from "../api.service";

/** God mode's Messages settings and exports (`/api/instances/chat/`). Instance admins only. */
export class InstanceChatService extends APIService {
  constructor(BASE_URL?: string) {
    super(BASE_URL || API_BASE_URL);
  }

  async settings(): Promise<TInstanceChatSettings> {
    return this.get("/api/instances/chat/settings/")
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** `retention_days`: 0 keeps messages forever. */
  async updateSettings(data: { retention_days: number }): Promise<TInstanceChatSettings> {
    return this.patch("/api/instances/chat/settings/", data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** The most recent exports, newest first. */
  async listExports(): Promise<TMessageExport[]> {
    return this.get("/api/instances/chat/exports/")
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async createExport(data: TMessageExportCreate): Promise<TMessageExport> {
    return this.post("/api/instances/chat/exports/", data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** A link to download the archive, valid for about a minute: follow it at once. */
  async downloadUrl(exportId: string): Promise<string> {
    return this.get(`/api/instances/chat/exports/${encodeURIComponent(exportId)}/download/`)
      .then((response) => response?.data?.url)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}
