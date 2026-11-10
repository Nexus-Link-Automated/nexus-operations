/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** The days a new retention setting starts at when it is turned on. */
export const DEFAULT_RETENTION_DAYS = 365;

/** The days typed, or null if that isn't a whole number in range. */
export function parseRetentionDays(input: string, min: number, max: number): number | null {
  const text = input.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const days = Number(text);
  return days >= min && days <= max ? days : null;
}

/**
 * Whether saving `next` deletes messages that `current` keeps: turning retention on, or shortening it. That deletes
 * them for good on the next daily run, so it is confirmed first. 0 is forever.
 */
export function deletesMore(current: number, next: number): boolean {
  if (next === 0) return false;
  return current === 0 || next < current;
}

export type TRatePeriod = "second" | "minute" | "hour" | "day";

/** A DRF rate such as "30/minute" (or "30/m") as a count and a period, or null if it isn't one. */
export function parseRate(rate: string): { count: number; period: TRatePeriod } | null {
  const match = /^(\d+)\/([smhd])[a-z]*$/.exec(rate.trim());
  if (!match) return null;
  const periods: Record<string, TRatePeriod> = { s: "second", m: "minute", h: "hour", d: "day" };
  return { count: Number(match[1]), period: periods[match[2]!]! };
}

/** A byte count for people: "512 B", "1.5 MB". */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}
