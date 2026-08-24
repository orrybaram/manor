---
title: Extract day bucketing out of TasksView
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Extract day bucketing out of TasksView

Mechanical extraction so the notification list (ticket 5) groups by day using
the same rule as the tasks list rather than a copy that drifts.

`src/components/sidebar/TasksView/TasksView.tsx` currently defines, at module
scope:

- `type DateBucket = "Today" | "Yesterday" | "This Week" | "This Month" | "Older"`
- `const BUCKET_ORDER: DateBucket[]`
- `function getDateBucket(dateStr: string): DateBucket`

Move all three verbatim into a new `src/utils/date-buckets.ts`, exported. Do
not change the bucketing logic — the week boundary (`startOfWeek` from
`getDay()`) and the month boundary stay exactly as written.

Then import them in `TasksView.tsx` and delete the local definitions. Nothing
else in that file changes; `matchesFilter`, `StatusFilter` and the components
stay put.

Verify with `npm run typecheck` that no other module was relying on these being
local (they are not exported today, so nothing can be).

## Files to touch

- `src/utils/date-buckets.ts` — new. `DateBucket`, `BUCKET_ORDER`,
  `getDateBucket`, moved unchanged.
- `src/components/sidebar/TasksView/TasksView.tsx` — import from the new module,
  delete the three local definitions.
