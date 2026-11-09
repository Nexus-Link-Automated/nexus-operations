/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ChartDataType, IGanttBlock } from "@plane/types";
import { renderFormattedPayloadDate } from "@plane/utils";
import { getDateFromPositionOnGantt, getItemPositionWidth } from "./helpers";

const DAY_WIDTH = 20;
const hostTimeZone = process.env.TZ;

afterEach(() => {
  if (hostTimeZone === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = hostTimeZone;
});

describe("getItemPositionWidth", () => {
  // Each range is five calendar days with the 25-hour day (24.5 on Lord Howe) inside it.
  it.each([
    ["America/New_York", "2026-10-30", "2026-11-03"],
    ["Europe/London", "2026-10-23", "2026-10-27"],
    ["Australia/Sydney", "2026-04-03", "2026-04-07"],
    ["Australia/Lord_Howe", "2026-04-03", "2026-04-07"],
  ])("keeps a bar across the autumn clock change in %s one day per date", (timeZone, startDate, targetDate) => {
    process.env.TZ = timeZone;
    // Guards against the runner ignoring TZ, which would let this pass without exercising a clock change.
    expect(new Date(`${startDate}T12:00:00`).getTimezoneOffset()).not.toBe(
      new Date(`${targetDate}T12:00:00`).getTimezoneOffset()
    );

    const chartData = { data: { startDate: new Date(2026, 0, 1), dayWidth: DAY_WIDTH } } as ChartDataType;
    const position = getItemPositionWidth(chartData, {
      start_date: startDate,
      target_date: targetDate,
    } as IGanttBlock);

    expect(position?.width).toBe(5 * DAY_WIDTH);

    // The dates a click or drag writes back are derived from the bar, so they must round-trip.
    const left = position?.marginLeft ?? 0;
    const right = left + (position?.width ?? 0);
    expect(renderFormattedPayloadDate(getDateFromPositionOnGantt(left, chartData))).toBe(startDate);
    expect(renderFormattedPayloadDate(getDateFromPositionOnGantt(right, chartData, -1))).toBe(targetDate);
  });
});
