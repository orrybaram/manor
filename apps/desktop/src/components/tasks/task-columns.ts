/**
 * The Tasks table's columns: their order, widths and which ones a person can
 * hide. Header, rows and loading rows all lay out from `gridTemplate`, so
 * they always line up.
 */

import {
  TASK_FIELDS,
  type TaskFieldId,
  type TaskProvider,
} from "../../lib/tasks";

/** A column that can be resized and hidden — every one but the action and Title. */
export type TaskColumnId = Extract<
  TaskFieldId,
  "id" | "assignee" | "status" | "priority" | "updated"
>;

type TaskColumnDef = {
  id: TaskColumnId;
  label: string;
  defaultWidth: number;
  minWidth: number;
};

/** In table order; Title sits between ID and Assignees. */
export const TASK_COLUMNS: readonly TaskColumnDef[] = [
  { id: "id", label: "ID", defaultWidth: 80, minWidth: 56 },
  { id: "assignee", label: "Assignees", defaultWidth: 88, minWidth: 48 },
  { id: "status", label: "Status", defaultWidth: 88, minWidth: 48 },
  { id: "priority", label: "Priority", defaultWidth: 40, minWidth: 32 },
  { id: "updated", label: "Updated", defaultWidth: 104, minWidth: 56 },
];

const COLUMN_BY_ID = Object.fromEntries(
  TASK_COLUMNS.map((c) => [c.id, c]),
) as Record<TaskColumnId, TaskColumnDef>;

export const ACTION_COLUMN_WIDTH = 64;
/** Title takes what's left, but never less than this; past it the table scrolls sideways. */
export const MIN_TITLE_WIDTH = 120;
export const MAX_COLUMN_WIDTH = 480;

export type TaskColumnWidths = Record<TaskColumnId, number>;

export const DEFAULT_COLUMN_WIDTHS = Object.fromEntries(
  TASK_COLUMNS.map((c) => [c.id, c.defaultWidth]),
) as TaskColumnWidths;

/** Which table a hidden set belongs to: full width, or beside the open drawer. */
export type TaskTableMode = "table" | "drawer";

export type HiddenColumns = Record<TaskTableMode, readonly TaskColumnId[]>;

/** Beside the drawer, Assignees and Priority start hidden to make room. */
export const DEFAULT_HIDDEN_COLUMNS: HiddenColumns = {
  table: [],
  drawer: ["assignee", "priority"],
};

export function isTaskColumnId(value: unknown): value is TaskColumnId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(COLUMN_BY_ID, value)
  );
}

export function columnLabel(id: TaskColumnId): string {
  return COLUMN_BY_ID[id].label;
}

export function defaultColumnWidth(id: TaskColumnId): number {
  return COLUMN_BY_ID[id].defaultWidth;
}

/** `width` rounded and held between the column's minimum and `MAX_COLUMN_WIDTH`. */
export function clampColumnWidth(id: TaskColumnId, width: number): number {
  return Math.max(
    COLUMN_BY_ID[id].minWidth,
    Math.min(MAX_COLUMN_WIDTH, Math.round(width)),
  );
}

/** The columns `provider` has (Priority is Linear's), in table order. */
export function columnsFor(provider: TaskProvider): TaskColumnId[] {
  return TASK_COLUMNS.map((c) => c.id).filter((id) =>
    TASK_FIELDS[id].providers.includes(provider),
  );
}

/** The columns `provider` has, minus the hidden ones, in table order. */
export function visibleColumns(
  provider: TaskProvider,
  hidden: readonly TaskColumnId[],
): TaskColumnId[] {
  return columnsFor(provider).filter((id) => !hidden.includes(id));
}

/** The table's `grid-template-columns`: action, the visible columns, Title in its place. */
export function gridTemplate(
  visible: readonly TaskColumnId[],
  widths: TaskColumnWidths,
): string {
  const tracks = [`${ACTION_COLUMN_WIDTH}px`];
  if (visible.includes("id")) tracks.push(`${widths.id}px`);
  tracks.push(`minmax(${MIN_TITLE_WIDTH}px, 1fr)`);
  for (const id of visible) {
    if (id !== "id") tracks.push(`${widths[id]}px`);
  }
  return tracks.join(" ");
}

/** Saved widths, clamped; a column with no usable saved width gets its default. */
export function parseColumnWidths(raw: string | null): TaskColumnWidths {
  const out = { ...DEFAULT_COLUMN_WIDTHS };
  if (!raw) return out;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const { id } of TASK_COLUMNS) {
      const value = saved?.[id];
      if (typeof value === "number" && Number.isFinite(value)) {
        out[id] = clampColumnWidth(id, value);
      }
    }
  } catch {
    // Not JSON — the defaults.
  }
  return out;
}

/** Saved hidden sets, keeping only known columns; a mode with no usable set gets its default. */
export function parseHiddenColumns(raw: string | null): HiddenColumns {
  if (!raw) return DEFAULT_HIDDEN_COLUMNS;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const read = (mode: TaskTableMode) => {
      const list = saved?.[mode];
      return Array.isArray(list)
        ? [...new Set(list.filter(isTaskColumnId))]
        : DEFAULT_HIDDEN_COLUMNS[mode];
    };
    return { table: read("table"), drawer: read("drawer") };
  } catch {
    return DEFAULT_HIDDEN_COLUMNS;
  }
}
