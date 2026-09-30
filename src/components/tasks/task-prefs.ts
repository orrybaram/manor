/**
 * The Tasks view's remembered choices, in localStorage. Home's Up next reads
 * the same tracker, project, sort and filters (ADR-202 §4), so it lists the
 * top of exactly what "View all" opens.
 */

import { useCallback, useState } from "react";
import {
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  filterableFields,
  sortableFields,
  type TaskFieldId,
  type TaskFilters,
  type TaskProvider,
  type TaskSort,
} from "../../lib/tasks";

const PREF_PROVIDER = "tasks-view:provider";
const PREF_PROJECT = "tasks-view:project";
/** Followed by the provider: each tracker remembers its own sort and filters. */
const PREF_SORT = "tasks-view:sort:";
const PREF_FILTERS = "tasks-view:filters:";
/** The saved project value for "All projects". */
const ALL_PROJECTS = "__all__";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
}

/** The last tracker chosen in the Tasks view. */
function readProvider(): TaskProvider {
  return readPref(PREF_PROVIDER) === "linear" ? "linear" : "github";
}

/** A provider's saved sort, if it's still a sortable field of it; else the default. */
function readSort(provider: TaskProvider): TaskSort {
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
function readFilters(provider: TaskProvider): TaskFilters {
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

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  const other = new Set(b);
  return set.size === other.size && [...set].every((v) => other.has(v));
}

/**
 * Are `filters` the defaults (your tasks nobody has started)? Order of
 * fields and values doesn't matter; an empty list counts as absent.
 */
export function isDefaultFilters(filters: TaskFilters): boolean {
  const fields = new Set([
    ...Object.keys(filters),
    ...Object.keys(DEFAULT_TASK_FILTERS),
  ]) as Set<TaskFieldId>;
  return [...fields].every((field) =>
    sameValues(filters[field] ?? [], DEFAULT_TASK_FILTERS[field] ?? []),
  );
}

export type TaskPrefs = {
  /** The last tracker chosen (it may no longer be usable — see `useTaskScope`). */
  provider: TaskProvider;
  /** The last project chosen, as a top-level entry key; null = all projects. */
  project: string | null;
  sorts: Record<TaskProvider, TaskSort>;
  /** Each provider keeps its own filters — their fields differ. */
  filtersBy: Record<TaskProvider, TaskFilters>;
  setProvider: (next: TaskProvider) => void;
  setProject: (next: string | null) => void;
  setSort: (provider: TaskProvider, next: TaskSort) => void;
  setFilters: (provider: TaskProvider, next: TaskFilters) => void;
};

/**
 * The saved Tasks choices, read from localStorage once on mount; the setters
 * update and save them. The Tasks view and Home aren't mounted together, so
 * each reads what the other last wrote.
 */
export function useTaskPrefs(): TaskPrefs {
  const [provider, setProviderState] = useState<TaskProvider>(readProvider);
  const [project, setProjectState] = useState<string | null>(() => {
    const saved = readPref(PREF_PROJECT);
    return saved === ALL_PROJECTS ? null : saved;
  });
  const [sorts, setSorts] = useState<Record<TaskProvider, TaskSort>>(() => ({
    github: readSort("github"),
    linear: readSort("linear"),
  }));
  const [filtersBy, setFiltersBy] = useState<Record<TaskProvider, TaskFilters>>(
    () => ({
      github: readFilters("github"),
      linear: readFilters("linear"),
    }),
  );

  const setProvider = useCallback((next: TaskProvider) => {
    setProviderState(next);
    writePref(PREF_PROVIDER, next);
  }, []);

  const setProject = useCallback((next: string | null) => {
    setProjectState(next);
    writePref(PREF_PROJECT, next ?? ALL_PROJECTS);
  }, []);

  const setSort = useCallback((p: TaskProvider, next: TaskSort) => {
    setSorts((prev) => ({ ...prev, [p]: next }));
    writePref(PREF_SORT + p, JSON.stringify(next));
  }, []);

  const setFilters = useCallback((p: TaskProvider, next: TaskFilters) => {
    setFiltersBy((prev) => ({ ...prev, [p]: next }));
    writePref(PREF_FILTERS + p, JSON.stringify(next));
  }, []);

  return {
    provider,
    project,
    sorts,
    filtersBy,
    setProvider,
    setProject,
    setSort,
    setFilters,
  };
}
