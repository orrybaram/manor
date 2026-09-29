---
title: Task field model for filtering and sorting
status: done
priority: high
assignee: opus
blocked_by: [1]
---

# Task field model for filtering and sorting

See ADR-201 §4. Pure code in `src/lib/tasks.ts`, no React.

- `export type TaskFieldId = "status" | "priority" | "assignee" | "author" |
  "label" | "trackerProject" | "milestone" | "cycle" | "team" | "project" |
  "id" | "title" | "updated" | "created" | "dueDate" | "estimate" | "comments"`
  (`project` = the Manor sidebar entry, `trackerProject` = Linear project /
  GitHub Projects v2).
- `export const TASK_FIELDS: Record<TaskFieldId, TaskFieldDef>` with
  `{ label, providers: TaskProvider[], facet?: (row) => string[],
  compare?: (a, b) => number, optionOrder?: (a: string, b: string) => number }`.
  A field is filterable iff it has `facet`, sortable iff it has `compare`.
  Use the table in ADR-201 §4 for which provider/filter/sort applies.
  - Status sort: by tone workflow order (todo/triage, backlog, started, open,
    closed, canceled — choose a sensible order and document it), then label.
  - Priority: Linear 1 Urgent, 2 High, 3 Medium, 4 Low, 0/absent "No priority"
    — sort Urgent first ascending, "No priority" always last. Facet option
    order follows priority, not alphabetical.
  - ID: numeric-aware (`#9` before `#10`, `ENG-9` before `ENG-10`) — use
    `localeCompare(…, { numeric: true })`.
  - Dates: parse ms; missing values last regardless of direction.
- `export const NONE_VALUE = "__none__"` — the facet value for rows whose
  facet is empty (label it "No <field>" in UI; export a `facetLabel` helper).
- `fieldsFor(provider): TaskFieldId[]`, `filterableFields(provider)`,
  `sortableFields(provider)`.
- `facetOptions(rows, fieldId): { value: string; count: number }[]` — from
  loaded rows, `NONE_VALUE` included when any row lacks the facet; ordered by
  `optionOrder` if present else alphabetical, `NONE_VALUE` last.
- `export type TaskFilters = Partial<Record<TaskFieldId, string[]>>`;
  `applyTaskFilters(rows, filters)` — AND across fields, any-of within a
  field; empty arrays ignored.
- `export type TaskSort = { field: TaskFieldId; direction: "asc" | "desc" }`;
  `DEFAULT_TASK_SORT = { field: "updated", direction: "desc" }`;
  `sortTasksBy(rows, sort)` — stable; missing values last in both
  directions; ties fall back to updated desc.
- Keep existing `sortTasks` (used by `collectTasks`/`linkedTasks`) or make it
  delegate to `sortTasksBy(DEFAULT_TASK_SORT)`.
- Generic over `TaskRow | LinkedTask` (both carry the fields after ticket 1).
- Thorough tests in `src/lib/tasks.test.ts`: each field's facet + compare,
  None handling, AND/OR semantics, stability, missing-last in both directions.

## Files to touch
- `src/lib/tasks.ts`
- `src/lib/tasks.test.ts`
