---
title: Hide orphaned active tasks in the sidebar
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Hide orphaned active tasks in the sidebar

Defense-in-depth for the duplication bug: a live task always owns a pane, so an
`active` task with `paneId == null` is a stranded record that should not render.
This protects the sidebar regardless of how an orphan was produced.

## Implementation

In `src/components/sidebar/TasksList.tsx`, tighten the `visibleTasks` `useMemo`
filter. Current:

```ts
const visibleTasks = useMemo(
  () =>
    tasks.filter(
      (t) =>
        t.status === "active" ||
        (t.paneId != null && activePaneIds.has(t.paneId)),
    ),
  [tasks, activePaneIds],
);
```

Change the first clause to also require a pane:

```ts
const visibleTasks = useMemo(
  () =>
    tasks.filter(
      (t) =>
        (t.status === "active" && t.paneId != null) ||
        (t.paneId != null && activePaneIds.has(t.paneId)),
    ),
  [tasks, activePaneIds],
);
```

Update the explanatory comment above the filter (currently "Show active tasks
always; ...") to reflect that active tasks show only while they still own a pane,
and that orphaned active records (paneId null) are hidden because they can't be
navigated to.

This is intentionally conservative: a genuinely-running task always has a
`paneId`, and an active task without one can't be opened via `navigateToTask`
(it early-returns on the missing `paneId`), so hiding it loses no reachable
functionality.

## Files to touch
- `src/components/sidebar/TasksList.tsx` — tighten `visibleTasks` filter so active tasks require a non-null `paneId`; update the adjacent comment.
