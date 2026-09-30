/**
 * The Tasks view's remembered choices, in localStorage. Home's Up next reads
 * the same sort and filters so it lists the top of what the Tasks view shows.
 */

import {
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  filterableFields,
  sortableFields,
  type TaskFilters,
  type TaskProvider,
  type TaskSort,
} from "../../lib/tasks";

export const PREF_PROVIDER = "tasks-view:provider";
export const PREF_PROJECT = "tasks-view:project";
/** Followed by the provider: each tracker remembers its own sort and filters. */
export const PREF_SORT = "tasks-view:sort:";
export const PREF_FILTERS = "tasks-view:filters:";

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
}

/** The last tracker chosen in the Tasks view. */
export function readProvider(): TaskProvider {
  return readPref(PREF_PROVIDER) === "linear" ? "linear" : "github";
}

/** A provider's saved sort, if it's still a sortable field of it; else the default. */
export function readSort(provider: TaskProvider): TaskSort {
  const raw = readPref(PREF_SORT + provider);
  if (!raw) return DEFAULT_TASK_SORT;
  try {
    const saved = JSON.parse(raw) as { field?: unknown; direction?: unknown };
    const field = sortableFields(provider).find((id) => id === saved.field);
    if (field && (saved.direction === "asc" || saved.direction === "desc")) {
      return { field, direction: saved.direction };
    }
  } catch {
    // Not JSON — fall through to the default.
  }
  return DEFAULT_TASK_SORT;
}

/** A provider's saved filters, keeping only fields it can still filter on; else the defaults. */
export function readFilters(provider: TaskProvider): TaskFilters {
  const raw = readPref(PREF_FILTERS + provider);
  if (!raw) return DEFAULT_TASK_FILTERS;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const out: TaskFilters = {};
    for (const field of filterableFields(provider)) {
      const values = saved[field];
      if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
        out[field] = values;
      }
    }
    return out;
  } catch {
    return DEFAULT_TASK_FILTERS;
  }
}
