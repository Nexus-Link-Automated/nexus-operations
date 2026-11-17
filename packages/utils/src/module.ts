/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { sortBy } from "lodash-es";
// plane imports
import type { IModule, TModuleDisplayFilters, TModuleFilters, TModuleOrderByOptions } from "@plane/types";
// local imports
import { getDate } from "./datetime";
import { satisfiesDateFilter } from "./filter";

const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

/**
 * @description performs natural sorting of strings (handles numbers within strings correctly)
 * @param {string} a - first string to compare
 * @param {string} b - second string to compare
 * @returns {number} - comparison result (-1, 0, or 1)
 */
const naturalSort = (a: string, b: string): number => collator.compare(a, b);

export type TModuleProgress = {
  /** completed work items (or points), capped at the scope */
  completed: number;
  /** work items (or points) that count towards progress: everything except cancelled */
  scope: number;
  /** completed / scope as a whole percentage, rounded down so 100 means nothing is left */
  percentage: number;
};

/**
 * @description progress of a module. Cancelled work items are left out of the scope rather than
 * counted as done, the same rule cycles use, so every module view shows the same numbers.
 * @param {IModule} module
 * @param {"issues" | "points"} type - count work items or estimate points
 * @returns {TModuleProgress}
 */
export const getModuleProgress = (
  module: Pick<
    IModule,
    | "total_issues"
    | "completed_issues"
    | "cancelled_issues"
    | "total_estimate_points"
    | "completed_estimate_points"
    | "cancelled_estimate_points"
  >,
  type: "issues" | "points" = "issues"
): TModuleProgress => {
  const total = (type === "points" ? module.total_estimate_points : module.total_issues) || 0;
  const completed = (type === "points" ? module.completed_estimate_points : module.completed_issues) || 0;
  const cancelled = (type === "points" ? module.cancelled_estimate_points : module.cancelled_issues) || 0;

  const scope = Math.max(total - cancelled, 0);
  const cappedCompleted = Math.min(Math.max(completed, 0), scope);
  const percentage = scope > 0 ? Math.floor((cappedCompleted * 100) / scope) : 0;

  return { completed: cappedCompleted, scope, percentage };
};
/**
 * @description orders modules based on their status
 * @param {IModule[]} modules
 * @param {TModuleOrderByOptions | undefined} orderByKey
 * @returns {IModule[]}
 */
export const orderModules = (modules: IModule[], orderByKey: TModuleOrderByOptions | undefined): IModule[] => {
  let orderedModules: IModule[] = [];
  if (modules.length === 0 || !orderByKey) return [];

  if (orderByKey === "name") orderedModules = [...modules].toSorted((a, b) => naturalSort(a.name, b.name));
  if (orderByKey === "-name") orderedModules = [...modules].toSorted((a, b) => naturalSort(b.name, a.name));
  if (["progress", "-progress"].includes(orderByKey))
    orderedModules = sortBy(modules, [
      (m) => {
        const { completed, scope } = getModuleProgress(m);
        const progress = scope > 0 ? completed / scope : 0;
        return orderByKey === "progress" ? progress : -progress;
      },
    ]);
  if (["issues_length", "-issues_length"].includes(orderByKey))
    orderedModules = sortBy(modules, [(m) => (orderByKey === "issues_length" ? m.total_issues : !m.total_issues)]);
  if (orderByKey === "target_date") orderedModules = sortBy(modules, [(m) => m.target_date]);
  if (orderByKey === "-target_date") orderedModules = sortBy(modules, [(m) => !m.target_date]);
  if (orderByKey === "created_at") orderedModules = sortBy(modules, [(m) => m.created_at]);
  if (orderByKey === "-created_at") orderedModules = sortBy(modules, [(m) => !m.created_at]);

  if (orderByKey === "sort_order") orderedModules = sortBy(modules, [(m) => m.sort_order]);
  return orderedModules;
};

/**
 * @description filters modules based on the filters
 * @param {IModule} module
 * @param {TModuleDisplayFilters} displayFilters
 * @param {TModuleFilters} filters
 * @returns {boolean}
 */
export const shouldFilterModule = (
  module: IModule,
  displayFilters: TModuleDisplayFilters,
  filters: TModuleFilters
): boolean => {
  let fallsInFilters = true;
  Object.keys(filters).forEach((key) => {
    const filterKey = key as keyof TModuleFilters;
    if (filterKey === "status" && filters.status && filters.status.length > 0)
      fallsInFilters = fallsInFilters && filters.status.includes(module.status?.toLowerCase() ?? "");
    if (filterKey === "lead" && filters.lead && filters.lead.length > 0)
      fallsInFilters = fallsInFilters && filters.lead.includes(`${module.lead_id}`);
    if (filterKey === "members" && filters.members && filters.members.length > 0) {
      const memberIds = module.member_ids ?? [];
      fallsInFilters = fallsInFilters && filters.members.some((memberId) => memberIds.includes(memberId));
    }
    if (filterKey === "start_date" && filters.start_date && filters.start_date.length > 0) {
      const startDate = getDate(module.start_date);
      filters.start_date.forEach((dateFilter) => {
        fallsInFilters = fallsInFilters && !!startDate && satisfiesDateFilter(startDate, dateFilter);
      });
    }
    if (filterKey === "target_date" && filters.target_date && filters.target_date.length > 0) {
      const endDate = getDate(module.target_date);
      filters.target_date.forEach((dateFilter) => {
        fallsInFilters = fallsInFilters && !!endDate && satisfiesDateFilter(endDate, dateFilter);
      });
    }
  });
  if (displayFilters.favorites && !module.is_favorite) fallsInFilters = false;

  return fallsInFilters;
};
