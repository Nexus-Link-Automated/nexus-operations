/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { deletesMore, formatSize, parseRate, parseRetentionDays } from "./helpers";

describe("parseRetentionDays", () => {
  it.each([
    ["30", 30],
    [" 365 ", 365],
    ["36500", 36500],
  ])("takes %j", (input, days) => {
    expect(parseRetentionDays(input, 30, 36500)).toBe(days);
  });

  it.each(["", "29", "0", "36501", "-30", "30.5", "1e3", "abc", "9999999"])("refuses %j", (input) => {
    expect(parseRetentionDays(input, 30, 36500)).toBeNull();
  });
});

describe("deletesMore", () => {
  it("is true when turning retention on or shortening it", () => {
    expect(deletesMore(0, 30)).toBe(true);
    expect(deletesMore(365, 90)).toBe(true);
  });

  it("is false when turning it off, lengthening it or keeping it", () => {
    expect(deletesMore(90, 0)).toBe(false);
    expect(deletesMore(90, 365)).toBe(false);
    expect(deletesMore(90, 90)).toBe(false);
    expect(deletesMore(0, 0)).toBe(false);
  });
});

describe("parseRate", () => {
  it("reads DRF rates, long or short", () => {
    expect(parseRate("30/minute")).toEqual({ count: 30, period: "minute" });
    expect(parseRate("500/h")).toEqual({ count: 500, period: "hour" });
    expect(parseRate("2/sec")).toEqual({ count: 2, period: "second" });
    expect(parseRate("10/day")).toEqual({ count: 10, period: "day" });
  });

  it("returns null for anything else", () => {
    expect(parseRate("fast")).toBeNull();
    expect(parseRate("10/week")).toBeNull();
  });
});

describe("formatSize", () => {
  it("picks a unit", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
