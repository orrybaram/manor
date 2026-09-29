---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-201: Tasks view — filter and sort by every field

Builds on ADR-198 (Tasks view).

## Context

The Tasks view (`src/components/tasks/TasksView.tsx`) lists GitHub and Linear
tasks in one table, but the only narrowing is the Open / Assigned / In progress
toggle and a free-text search, and rows are always sorted by last update. The
user wants to filter and sort by every column the trackers give us — for
Linear: priority, status, assignee, label, project (and anything else
available); for GitHub the same for whatever it returns — and wants the list
calls to return all the info they can.

Today the list calls are thin:

- GitHub (`electron/github.ts` `getMyIssues` / `getAllIssues`):
  `number,title,url,state,labels,assignees,updatedAt,author`.
- Linear (`electron/linear.ts` `getMyIssues` / `getAllIssues`): id,
  identifier, title, url, `state { name type }`, updatedAt, assignee, labels.
  No priority, project, cycle, estimate, due date, team, creator.

Also the page sits too close to the top of the window: `.page` has only
`padding-top: 8px`.

## Decision

### 1. Padding

`.page` in `TasksView.module.css` gets `padding-top: 40px`.

### 2. Richer list data

**GitHub** — `gh issue list --json` adds
`createdAt,closedAt,milestone,comments,stateReason,projectItems`.
`comments` is mapped to a `commentCount` in the main process (bodies are
dropped before crossing IPC). `projectItems` (GitHub Projects v2 membership:
project title + status) needs the `read:project` token scope; if `gh` fails
with a scope error the call retries once without `projectItems`, so a
standard token still works. Shared field list lives in one constant.

`GitHubIssue` gains optional `createdAt`, `closedAt`, `milestone`,
`commentCount`, `stateReason`, `projectItems: {title, status?}[]`.

**Linear** — list queries add `priority priorityLabel createdAt dueDate
estimate state { name type color } project { name } cycle { number name }
team { key name } creator { name displayName }`. `LinearIssue` gains the
matching optional fields.

### 3. `TaskRow` carries the fields

`src/lib/tasks.ts` `TaskRow` (and `LinkedTask`, via the fetched match) gains:
`priority?: {value, label}` (Linear; 0 = No priority sorts last),
`trackerProjects: string[]` (Linear project, or GitHub Projects v2 titles),
`milestone?` (GitHub), `cycle?` / `team?` / `estimate?` / `dueDate?`
(Linear), `createdAt`, `commentCount?` (GitHub). `author` also filled from
Linear `creator`.

### 4. A field model: filter + sort, pure and tested

In `src/lib/tasks.ts`, a `TASK_FIELDS` table keyed by `TaskFieldId`, each
entry: `label`, `providers` it applies to, `facet(row) → string[]` (values for
filtering; `[]` = "None"), and `compare(a, b)` for sorting. Fields:

| Field      | GitHub | Linear | Filter | Sort |
|------------|:------:|:------:|:------:|:----:|
| Status     | ✓ (Open/Closed, + reason) | ✓ | ✓ | ✓ (by workflow order: triage→backlog→todo→started→done→canceled) |
| Priority   |        | ✓      | ✓      | ✓ (Urgent→Low, None last) |
| Assignee   | ✓      | ✓      | ✓      | ✓ |
| Author/Creator | ✓  | ✓      | ✓      | ✓ |
| Label      | ✓      | ✓      | ✓      | — |
| Project (tracker) | ✓ (Projects v2) | ✓ | ✓ | ✓ |
| Milestone  | ✓      |        | ✓      | ✓ |
| Cycle      |        | ✓      | ✓      | ✓ |
| Team       |        | ✓      | ✓      | ✓ |
| Manor project (sidebar entry) | ✓ | ✓ | ✓ | ✓ |
| ID         | ✓      | ✓      | —      | ✓ (numeric-aware) |
| Title      | ✓      | ✓      | —      | ✓ |
| Updated / Created | ✓ | ✓    | —      | ✓ |
| Due date, Estimate | | ✓     | —      | ✓ |
| Comments   | ✓      |        | —      | ✓ |

Helpers: `facetOptions(rows, field)` → `{value, count}[]` built from the
loaded rows; `applyTaskFilters(rows, filters)` — AND across fields, OR within
a field (any-of), with a "None" value for empty facets;
`sortTasksBy(rows, {field, direction})` — stable, missing values last in
either direction. Unit-tested in `src/lib/tasks.test.ts`.

Facet values come from what's loaded (up to 50 per source), not from the
tracker's full catalogue — no extra API calls.

### 5. UI

In the filter row, next to search:

- **Filter** button (radix `Popover`, `Button` trigger with a count badge):
  a list of the fields that apply to the current provider; choosing one shows
  its values with counts as `Checkbox` rows (with a small search for long
  lists). Active filters render as removable chips below the filter row
  ("Priority: Urgent, High ×") plus "Clear all".
- **Sort** button (radix `Popover`): every sortable field for the provider,
  plus an Ascending/Descending `ToggleGroup`. Default: Updated, descending
  (today's behaviour).
- **Column headers** are sort buttons for the columns shown (ID, Title,
  Assignees, Status, Updated), with an arrow on the active one; click
  toggles direction.
- For Linear, the table gains a **Priority** column (icon + label) and the
  context line shows the Linear project / cycle; for GitHub it shows the
  milestone and Projects v2 titles. Grid template adjusts per provider.

Sort is remembered per provider in `localStorage` (same `readPref` /
`writePref` pattern). Filters are session-only and reset when the provider
changes (the field sets differ). Page resets to 1 on any change.

## Consequences

- Every column the trackers expose is filterable and sortable, client-side,
  with no extra requests.
- Filters only see loaded rows: a value outside the 50-per-source window
  won't appear. Server-side filtering is a follow-up if that bites.
- `projectItems` costs an extra scope; the fallback keeps plain tokens
  working but those users won't see GitHub project data.
- Payloads grow somewhat (Linear adds ~10 small fields; GitHub comment
  bodies are fetched by `gh` but stripped before IPC).
- The field table is the single place to add a new field later.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
