---
title: Tasks view padding, filter and sort UI
status: done
priority: high
assignee: opus
blocked_by: [2]
---

# Tasks view padding, filter and sort UI

See ADR-201 §1 and §5. Follow `.claude/rules/ui-components.md` (use `Button`,
`Tooltip`, `Checkbox`, `Input`, `ToggleGroup` from `src/components/ui/`) and
the existing radix `Popover` usage (e.g. `src/components/sidebar/PrPopover.tsx`)
for styling / portal conventions. Match the file's existing CSS-module style
and tokens.

1. `.page` in `TasksView.module.css`: `padding-top: 40px` (keep bottom 24px).
2. State in `TasksView`: `filters: TaskFilters` (reset on provider change,
   page → 1 on any change) and `sort: TaskSort` persisted per provider via
   `readPref`/`writePref` (`tasks-view:sort:<provider>`, JSON, validated
   against `sortableFields(provider)`, else `DEFAULT_TASK_SORT`).
3. Pipeline: `listed` → `applyTaskFilters` → `filterTasks(search)` →
   `sortTasksBy(sort)` → `paginate`. Facet options are computed from `listed`
   (before filters) so counts are stable.
4. New `TaskFilterMenu.tsx` in `src/components/tasks/`: `Button` trigger
   ("Filter", with a small count of active values — reuse
   `ui/CountBadge` if it fits), radix Popover content: first level lists
   `filterableFields(provider)`; picking one shows that field's
   `facetOptions` as `Checkbox` rows with counts and a search `Input` when
   > 8 options, plus a back control. Keyboard accessible.
5. New `TaskSortMenu.tsx`: `Button` trigger showing the current sort
   ("Sort: Updated ↓"), popover listing `sortableFields(provider)` as
   selectable rows plus an Asc/Desc `ToggleGroup`.
6. Active filter chips row under the filter bar (only when any filter set):
   "Priority: Urgent, High" with an × `Button` each, and "Clear all".
7. Column headers ID / Title / Assignees / Status / Updated (and Priority)
   become header `Button`s (`variant="ghost"`) that set the sort to that
   field (click again toggles direction), with an `ArrowUp`/`ArrowDown`
   icon on the active one and `aria-sort` on the columnheader.
8. Linear: add a **Priority** column (between Status and Updated) — Linear-
   style bar icon or a short label; `—` when none. Grid template differs per
   provider (add a modifier class on the table). Skeleton matches.
9. Context line: show Linear project / cycle, GitHub milestone / Projects v2
   titles as dim chips next to the Manor project name (keep it compact).
10. Empty state when filters exclude everything: "No tasks match these
    filters." with a Clear filters `Button`.

Run `pnpm typecheck` (or the repo's equivalent in package.json) and the
tasks tests before committing. If the repo has a component test pattern
for TasksView, extend it; otherwise don't add one.

## Files to touch
- `src/components/tasks/TasksView.tsx`
- `src/components/tasks/TasksView.module.css`
- `src/components/tasks/TaskFilterMenu.tsx` (new) + CSS module
- `src/components/tasks/TaskSortMenu.tsx` (new) + CSS module
