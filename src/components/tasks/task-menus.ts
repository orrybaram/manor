/**
 * Helpers shared by the Tasks view's Filter and Sort menus (ADR-201 §5),
 * kept out of the component files so they fast-refresh.
 */

import type { KeyboardEvent } from "react";
import type { TaskFieldId, TaskFilters, TaskSort } from "../../lib/tasks";

/** How many values are chosen across every field — the trigger's badge. */
export function activeFilterCount(filters: TaskFilters): number {
  return Object.values(filters).reduce((n, v) => n + (v?.length ?? 0), 0);
}

/**
 * Arrow-key movement between a popover list's items (`data-menu-item`):
 * Up / Down step, Home / End jump. Tab still works as usual.
 */
export function onMenuListKeyDown(e: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const items = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>("[data-menu-item]"),
  );
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

/** Fields where newest / most first is the natural reading. */
const DESC_FIRST: ReadonlySet<TaskFieldId> = new Set<TaskFieldId>([
  "updated",
  "created",
  "comments",
]);

/**
 * The direction a field starts in when it becomes the sort: newest / most
 * first for dates and counts, otherwise ascending (A→Z, Urgent→Low, to do →
 * done).
 */
export function initialDirection(field: TaskFieldId): TaskSort["direction"] {
  return DESC_FIRST.has(field) ? "desc" : "asc";
}
